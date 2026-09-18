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
        const parsed = unwrapCliOutput(stdout);
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

  function buildStatus(d, messagingOk, directOk, needsLogin) {
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
}

const authRequired = (error) => ({ ok: false, error, errorType: 'AUTH_REQUIRED' });

  // Own MRI (e.g. "8:orgid:<guid>") for isFromMe detection, cached per process.
  let ownMriCache = null;
  async function getOwnMri() {
    if (ownMriCache !== null) return ownMriCache;
    try {
      const res = await callCli(TOOL.GET_ME);
      const src = res.data ?? {};
      const p = src.profile ?? src;
      ownMriCache = p.mri || p.id || '';
    } catch {
      ownMriCache = '';
    }
    return ownMriCache;
  }

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
      // The status tool reads the token store without refreshing it, so an
      // expired-but-refreshable session looks unauthenticated forever. A real
      // API call triggers msteams-mcp auto-refresh; probe with get_me, then
      // re-read status. Retry at most once to keep the poller cheap.
      if (!(messagingOk || directOk) && !needsLogin) {
        const probe = await callCli(TOOL.GET_ME);
        if (probe.ok) {
          const again = await callCli(TOOL.STATUS);
          if (again.ok) {
            const d2 = again.data ?? {};
            const messagingOk2 = d2?.messaging?.available === true;
            const directOk2 = d2?.directApi?.available === true;
            const needsLogin2 = d2?.teamsAuthService?.needsInteractiveLogin === true;
            if (messagingOk2 || directOk2) {
              return buildStatus(d2, messagingOk2, directOk2, needsLogin2);
            }
          }
        }
      }
      return buildStatus(d, messagingOk, directOk, needsLogin);
    },

    // { ok, user: { id, displayName, email } }
    async getCurrentUser() {
      const res = await callCli(TOOL.GET_ME);
      if (!res.ok) {
        return res.errorType === 'AUTH_REQUIRED'
          ? authRequired(res.error)
          : { ok: false, error: res.error, errorType: res.errorType };
      }
      // teams_get_me returns { success, profile } (profile at top level,
      // not nested under data).
      const src = res.data ?? {};
      const p = src.profile ?? src;
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
      // The CLI reports isFromMe: false for every message, so detect own
      // messages here by comparing the sender MRI with the account identity.
      const ownMri = await getOwnMri();
      const messages = (res.data?.messages ?? res.messages ?? [])
        .map((m) => normalizeMessage(m, chatId))
        .filter(Boolean)
        .map((m) => ({
          ...m,
          isFromMe: m.isFromMe === true || (ownMri && m.senderId === ownMri),
        }));
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

// The CLI prints an MCP envelope like:
//   { "content": [ { "type": "text", "text": "{\"success\":true,\"data\":{...}}" } ] }
// (npm may also echo its run banner to stdout before the JSON, so we scan.)
// Returns the inner tool result object, or null if nothing parseable.
function unwrapCliOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  for (const candidate of balancedJsonObjects(text)) {
    const inner = extractToolResult(candidate);
    if (inner) return inner;
  }
  return null;
}

// Yield the top-level JSON objects found in `text` (first match wins in
// practice, but keep all candidates for defensive parsing).
function balancedJsonObjects(text) {
  const out = [];
  const start = text.indexOf('{');
  if (start === -1) return out;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && objectStart !== -1) {
          const slice = text.slice(objectStart, i + 1);
          try {
            out.push(JSON.parse(slice));
          } catch {
            /* skip malformed object */
          }
          objectStart = -1;
        }
      }
    }
  }
  return out;
}

// Given a parsed JSON candidate, resolve the inner tool result: unwrap the
// MCP content[0].text envelope if present, preferring results that declare
// `success`/`data` (the shape msteams-mcp tools return).
function extractToolResult(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  if (candidate.success !== undefined || candidate.data !== undefined) return candidate;
  const text = candidate?.content?.[0]?.text;
  if (typeof text === 'string') {
    const nested = parseCliOutput(text);
    if (nested && (nested.success !== undefined || nested.data !== undefined)) return nested;
  }
  return null;
}

function parseCliOutput(text) {
  const str = String(text ?? '').trim();
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    // Find the last balanced JSON object in the output.
    const start = str.indexOf('{');
    if (start === -1) return null;
    for (let end = str.lastIndexOf('}'); end > start; end = str.lastIndexOf('}', end - 1)) {
      try {
        return JSON.parse(str.slice(start, end + 1));
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
