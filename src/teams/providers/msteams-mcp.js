// ─────────────────────────────────────────────────────────────────────────────
// msteams-mcp TeamsProvider implementation (local CLI adapter).
//
// Talks to the local msteams-mcp checkout (https://github.com/hickeroar/msteams-mcp)
// through its CLI (`npm run cli -- --json teams_<tool> --key value`). The CLI
// wraps the same tools as the MCP server and reuses the browser-session token
// cache, so no Azure/Entra app registration is needed.
//
// Provider specifics live ONLY here. The rest of the app depends on the
// interface in ../provider.js and on the normalized message shape in
// ../normalize.js — command names and payload quirks must not leak out.
//
// Session/auth files are handled by the MCP project itself; we only point HOME
// at the mounted session directory (MSTEAMS_SESSION_PATH) and never read or
// log their contents.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { normalizeMessage, normalizeConversation } from '../normalize.js';

const DEFAULT_TIMEOUT_MS = 90_000;

// Maps provider operations to msteams-mcp tool names. Kept in one place so a
// rename upstream is a one-line change; nothing outside may use these.
const TOOL = {
  STATUS: 'teams_status',
  GET_ME: 'teams_get_me',
  LIST_CHATS: 'teams_list_chats',
  GET_THREAD: 'teams_get_thread',
  SEND_MESSAGE: 'teams_send_message',
};

export function createMsTeamsMcpProvider({ logger = { info() {}, warn() {}, error() {} } } = {}) {
  const mcpPath = process.env.MSTEAMS_MCP_PATH || '';
  const sessionPath = process.env.MSTEAMS_SESSION_PATH || '/app/teams-session';
  const timeoutMs = Number(process.env.MSTEAMS_MCP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  function configOk() {
    return !!mcpPath && fs.existsSync(path.join(mcpPath, 'package.json'));
  }

  // Runs one CLI call, parses the --json envelope, normalizes errors.
  // Never throws for provider failures; resolves { ok, data | error, errorType }.
  async function callCli(toolName, args = {}, { timeout = timeoutMs } = {}) {
    if (!configOk()) {
      return {
        ok: false,
        error: `MSTEAMS_MCP_PATH is not set or invalid (${mcpPath || 'unset'})`,
        errorType: 'PROVIDER_ERROR',
      };
    }
    const argv = ['run', 'cli', '--', '--json', toolName];
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      argv.push(`--${key}`, String(value));
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn('npm', argv, {
        cwd: mcpPath,
        env: {
          ...process.env,
          // The MCP session store lives under $HOME/.teams-mcp-server on
          // Linux; pointing HOME at the mounted volume keeps sessions
          // persistent and outside the image.
          HOME: sessionPath,
          NODE_ENV: 'production',
          NO_COLOR: '1',
        },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, error: `msteams-mcp CLI timeout after ${timeout}ms`, errorType: 'PROVIDER_ERROR' });
      }, timeout);

      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: `failed to run msteams-mcp CLI: ${err.message}`, errorType: 'PROVIDER_ERROR' });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parsed = parseCliOutput(stdout);
        if (parsed) {
          if (parsed.success === false) {
            resolve({
              ok: false,
              error: typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error ?? 'unknown provider error'),
              errorType: /auth/i.test(String(parsed.errorCode ?? '')) || /session|login/i.test(String(parsed.error ?? ''))
                ? 'AUTH_REQUIRED'
                : 'PROVIDER_ERROR',
            });
          } else {
            resolve({ ok: true, data: parsed.data ?? parsed });
          }
          return;
        }
        resolve({
          ok: false,
          error: `msteams-mcp CLI failed (exit ${code})${stderr ? `: ${lastLine(stderr)}` : ''}`,
          errorType: 'PROVIDER_ERROR',
        });
      });
    });
  }

  const authRequired = (error) => ({ ok: false, error, errorType: 'AUTH_REQUIRED' });

  return {
    name: 'msteams-mcp',

    // { ok, authenticated, loginRequired, error, details }
    async status() {
      const res = await callCli(TOOL.STATUS);
      if (!res.ok) return { ok: false, authenticated: false, loginRequired: false, error: res.error };
      const d = res.data ?? {};
      const needsLogin = d?.teamsAuthService?.needsInteractiveLogin === true;
      const messagingOk = d?.messaging?.available === true;
      const directOk = d?.directApi?.available === true;
      return {
        ok: true,
        authenticated: messagingOk || directOk,
        loginRequired: needsLogin,
        error: needsLogin ? 'Teams login required' : null,
        details: {
          messaging: messagingOk,
          directApi: directOk,
          sessionExists: d?.session?.exists === true,
          sessionLikelyExpired: d?.session?.likelyExpired === true,
        },
      };
    },

    // { ok, user: { id, displayName, email } }
    async getCurrentUser() {
      const res = await callCli(TOOL.GET_ME);
      if (!res.ok) {
        return res.errorType === 'AUTH_REQUIRED'
          ? authRequired(res.error)
          : { ok: false, error: res.error, errorType: res.errorType };
      }
      const p = res.data?.profile ?? {};
      return {
        ok: true,
        user: {
          id: p.mri || p.id || p.userPrincipalName || '',
          displayName: p.displayName || p.name || '',
          email: p.email || p.mail || p.userPrincipalName || '',
        },
      };
    },

    // { ok, chats: [{ id, title, type, participants, lastMessage }] }
    async listChats({ limit = 100 } = {}) {
      const res = await callCli(TOOL.LIST_CHATS, { limit });
      if (!res.ok) {
        return res.errorType === 'AUTH_REQUIRED'
          ? authRequired(res.error)
          : { ok: false, error: res.error, errorType: res.errorType };
      }
      const chats = (res.data?.conversations ?? [])
        .map((c) => normalizeConversation(c))
        .filter(Boolean);
      return { ok: true, chats };
    },

    // Best-effort lookup from recent chats; { ok, chat } | { ok: false }.
    async getChat(chatId) {
      const res = await this.listChats({ limit: 200 });
      if (!res.ok) return res;
      const chat = res.chats.find((c) => c.id === chatId);
      return chat ? { ok: true, chat } : { ok: false, error: 'chat not found in recent chats', errorType: 'NOT_FOUND' };
    },

    // { ok, messages: [normalizedMessage] }
    async getMessages(chatId, { since = null, limit = 50 } = {}) {
      const args = { conversationId: chatId, limit, order: 'asc' };
      if (since) args.since = since;
      const res = await callCli(TOOL.GET_THREAD, args);
      if (!res.ok) {
        return res.errorType === 'AUTH_REQUIRED'
          ? authRequired(res.error)
          : { ok: false, error: res.error, errorType: res.errorType };
      }
      const messages = (res.data?.messages ?? [])
        .map((m) => normalizeMessage(m, chatId))
        .filter(Boolean);
      return { ok: true, messages };
    },

    // { ok, teamsMessageId, error, errorType }
    async sendMessage(chatId, text, { replyToMessageId = null } = {}) {
      if (!chatId) return { ok: false, error: 'chatId is required', errorType: 'PROVIDER_ERROR' };
      const content = String(text ?? '');
      if (!content.trim()) return { ok: false, error: 'empty message text', errorType: 'PROVIDER_ERROR' };

      const args = {
        conversationId: chatId,
        content,
        // Drafts are plain text; send verbatim so markdown/underscore
        // characters are never reinterpreted.
        contentType: 'text',
      };
      if (replyToMessageId) args.replyToMessageId = replyToMessageId;

      const res = await callCli(TOOL.SEND_MESSAGE, args, { timeout: Math.max(timeoutMs, 60_000) });
      if (!res.ok) {
        logger.warn({ error: res.error }, 'teams sendMessage failed');
        return res.errorType === 'AUTH_REQUIRED'
          ? authRequired(res.error)
          : { ok: false, error: res.error, errorType: res.errorType };
      }
      // Prefer serverMessageId (stable server-assigned id), fall back to
      // messageId/client id.
      const d = res.data ?? {};
      const teamsMessageId = d.serverMessageId || d.messageId || d.timestamp || null;
      if (!teamsMessageId) {
        // CLI reported success without an id — treat as sent, id unknown.
        return { ok: true, teamsMessageId: null };
      }
      return { ok: true, teamsMessageId: String(teamsMessageId) };
    },
  };
}

// Extracts the JSON envelope printed by the CLI (the whole output is one
// JSON document when --json is used; be defensive anyway).
function parseCliOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Find the last balanced JSON object in the output.
    const start = text.indexOf('{');
    if (start === -1) return null;
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* keep shrinking */
      }
    }
    return null;
  }
}

function lastLine(text) {
  return String(text).trim().split('\n').pop()?.slice(0, 300) ?? '';
}
