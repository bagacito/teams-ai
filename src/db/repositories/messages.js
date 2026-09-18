export function createMessageRepo(db) {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO messages (teams_message_id, chat_id, sender_id, sender_name, content, message_type, reply_to, is_me)
      VALUES (@teams_message_id, @chat_id, @sender_id, @sender_name, @content, @message_type, @reply_to, @is_me)
    `),
    recent: db.prepare(`
      SELECT * FROM messages WHERE chat_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `),
    getById: db.prepare('SELECT * FROM messages WHERE teams_message_id = ?'),
    countForChat: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?'),
    myCount: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE is_me = 1'),
    // Messages are inserted in conversation order (poller processes
    // oldest→newest), so a higher id means a later position in the thread.
    ownAfter: db.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM messages later
        JOIN messages source ON source.chat_id = later.chat_id AND source.id < later.id
        WHERE source.chat_id = ? AND source.teams_message_id = ? AND later.is_me = 1
      ) AS c
    `),
  };

  return {
    // Returns the inserted row, or null if the message was already stored.
    save(message) {
      try {
        const info = stmts.insert.run({
          teams_message_id: message.teamsMessageId,
          chat_id: message.chatId,
          sender_id: message.senderId ?? '',
          sender_name: message.senderName ?? '',
          content: message.content ?? '',
          message_type: message.messageType ?? 'message',
          reply_to: message.replyTo ?? null,
          is_me: message.isMe ? 1 : 0,
        });
        return stmts.getById.get(message.teamsMessageId);
      } catch (err) {
        if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
        throw err;
      }
    },
    recentForChat(chatId, limit = 20) {
      return stmts.recent.all(chatId, limit).reverse();
    },
    getById(teamsMessageId) {
      return stmts.getById.get(teamsMessageId);
    },
    countForChat(chatId) {
      return stmts.countForChat.get(chatId).c;
    },
    myMessageCount() {
      return stmts.myCount.get().c;
    },
    // True when a message from me is stored LATER in the thread than the
    // given message — i.e. I already answered it; no draft should be made.
    hasOwnMessageAfter(chatId, teamsMessageId) {
      return !!stmts.ownAfter.get(chatId, teamsMessageId).c;
    },
  };
}
