import { getRecentMessages } from './history.js';

export { getRecentMessages, stripHtml } from './history.js';

// Chat-specific context is stored on the allowed_chats row (`context` column).
export function getChatContext(chatId, settingsRepo) {
  return settingsRepo.get(`chat_context:${chatId}`, '') || '';
}

export function setChatContext(chatId, value, settingsRepo) {
  settingsRepo.set(`chat_context:${chatId}`, value ?? '');
}
