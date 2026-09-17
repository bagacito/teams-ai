import { graphFetch } from './graph.js';
import { logger } from '../logging.js';

// ─────────────────────────────────────────────────────────────────────────────
// Teams message sending.
//
// SECURITY BOUNDARY: this module may only be invoked from the approval flow
// (src/routes/drafts.js). The AI draft-generation pipeline (src/ai/*,
// src/webhook pipeline) MUST NOT import or call this module.
// No code path may go from "received message" to "sent reply" without an
// explicit human approval request going through this module's only export.
// ─────────────────────────────────────────────────────────────────────────────

export async function sendChatMessage(chatId, text) {
  const result = await graphFetch(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: {
      body: {
        contentType: 'text',
        content: text,
      },
    },
  });
  logger.info({ chatId, messageId: result?.id }, 'teams message sent');
  return result;
}
