// ─────────────────────────────────────────────────────────────────────────────
// TeamsProvider — the ONLY boundary between this application and Microsoft
// Teams. All Teams access goes through this interface; the implementation is
// pluggable (currently: the local msteams-mcp CLI adapter).
//
// Interface convention (all methods return plain objects; they never throw for
// expected provider failures — they return { ok: false, error, errorType }):
//
//   status()                  -> { ok, authenticated, loginRequired, error, details }
//   getCurrentUser()          -> { ok, user: { id, displayName, email } }
//   listChats()               -> { ok, chats: [{ id, title, type, participants, lastMessage }] }
//   getChat(chatId)           -> { ok, chat } | { ok: false }
//   getMessages(chatId, opts) -> { ok, messages: [normalizedMessage] }
//   sendMessage(chatId, text, opts) -> { ok, teamsMessageId, error, errorType }
//
// Normalized message shape (see normalize.js):
//   { id, chatId, senderId, senderName, senderEmail, content,
//     createdAt, replyToMessageId, isFromMe, rawType }
//
// SECURITY: sendMessage is the single send path into Teams. Only the approval
// route (routes/drafts.js, via the send wrapper wired in server.js) may
// invoke it. The AI draft module and the ingestion pipeline never receive a
// provider reference.
// ─────────────────────────────────────────────────────────────────────────────

export const ERROR_TYPES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NOT_FOUND: 'NOT_FOUND',
};

export function authRequiredResult(error) {
  return { ok: false, error: error ?? 'Teams authentication required', errorType: ERROR_TYPES.AUTH_REQUIRED };
}

export function providerError(error, errorType = ERROR_TYPES.PROVIDER_ERROR) {
  return { ok: false, error, errorType };
}

import { createMsTeamsMcpProvider } from './providers/msteams-mcp.js';

export function createTeamsProvider({ logger } = {}) {
  const kind = process.env.TEAMS_PROVIDER || 'msteams-mcp';
  switch (kind) {
    case 'msteams-mcp':
      return createMsTeamsMcpProvider({ logger });
    default:
      throw new Error(`Unknown TEAMS_PROVIDER: ${kind}`);
  }
}
