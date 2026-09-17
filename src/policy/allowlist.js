// Allowlist policy. Isolated so rules can be changed later.
// A message is eligible if:
//   - the sender is in allowed_users (enabled), OR
//   - the chat is in allowed_chats (enabled)  [covers whole group chats]

export function createAllowlist({ userRepo, chatRepo, myUserId }) {
  return {
    isUserAllowed(entraUserId) {
      if (!entraUserId) return false;
      if (myUserId && entraUserId === myUserId) return false; // my own messages are never eligible
      const user = userRepo.getByEntraId(entraUserId);
      return !!user && !!user.enabled;
    },
    isChatAllowed(chatId) {
      if (!chatId) return false;
      const chat = chatRepo.getByChatId(chatId);
      return !!chat && !!chat.enabled;
    },
    getChat(chatId) {
      return chatRepo.getByChatId(chatId);
    },
    getUser(entraUserId) {
      return userRepo.getByEntraId(entraUserId);
    },
  };
}

// Core eligibility decision, easy to change or complement with AI classification later.
export function isMessageAllowed(allowlist, { senderId, chatId }) {
  return allowlist.isUserAllowed(senderId) || allowlist.isChatAllowed(chatId);
}
