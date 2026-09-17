export function createSummaryRepo(db) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO conversation_summaries (chat_id, summary, updated_at, last_message_id)
      VALUES (@chat_id, @summary, datetime('now'), @last_message_id)
      ON CONFLICT(chat_id) DO UPDATE SET
        summary = excluded.summary,
        updated_at = datetime('now'),
        last_message_id = excluded.last_message_id
    `),
    get: db.prepare('SELECT * FROM conversation_summaries WHERE chat_id = ?'),
    all: db.prepare('SELECT * FROM conversation_summaries ORDER BY updated_at DESC'),
  };

  return {
    upsert(chatId, summary, lastMessageId = null) {
      stmts.upsert.run({ chat_id: chatId, summary, last_message_id: lastMessageId });
    },
    get(chatId) {
      return stmts.get.get(chatId);
    },
    list() {
      return stmts.all.all();
    },
  };
}
