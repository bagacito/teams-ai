import { getChatMessages } from '../teams/graph.js';
import { logger } from '../logging.js';

// Builds recent-message context for prompt construction.
// Limited by RECENT_MESSAGE_COUNT (default 20) — never unlimited history.

export async function getRecentMessages(chatId, limit, messageRepo) {
  const max = Number(limit) || Number(process.env.RECENT_MESSAGE_COUNT) || 20;

  // Prefer stored history (from webhooks); fall back to a Graph fetch for new chats.
  let rows = messageRepo ? messageRepo.recentForChat(chatId, max) : [];

  if (rows.length === 0) {
    try {
      const graphMsgs = await getChatMessages(chatId, { top: max });
      rows = graphMsgs
        .filter((m) => m.messageType === 'message')
        .reverse()
        .map((m) => ({
          senderName: m.from?.user?.displayName ?? '',
          content: stripHtml(m.body?.content ?? ''),
          isMe: false,
        }));
    } catch (err) {
      logger.warn({ chatId, errStatus: err.status }, 'failed to fetch chat history from Graph');
      return [];
    }
  }

  return rows.map((r) => ({
    senderName: r.sender_name ?? r.senderName ?? '',
    content: stripHtml(r.content ?? ''),
    isMe: !!r.is_me || !!r.isMe,
  }));
}

export function stripHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}
