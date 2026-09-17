import { logger } from '../logging.js';

// Builds recent-message context for prompt construction.
// Limited by RECENT_MESSAGE_COUNT (default 20) — never unlimited history.
// History comes only from messages stored via the Teams ingestion pipeline.

export async function getRecentMessages(chatId, limit, messageRepo) {
  const max = Number(limit) || Number(process.env.RECENT_MESSAGE_COUNT) || 20;
  if (!messageRepo) return [];
  return messageRepo.recentForChat(chatId, max).map((r) => ({
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
