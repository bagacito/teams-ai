const nowIso = () => new Date().toISOString();

export function createPollStateRepo(db) {
  const stmts = {
    get: db.prepare('SELECT * FROM chat_poll_state WHERE chat_id = ?'),
    list: db.prepare('SELECT * FROM chat_poll_state'),
    upsert: db.prepare(`
      INSERT INTO chat_poll_state (chat_id, last_message_id, last_message_timestamp, last_poll_at, last_success_at, last_error)
      VALUES (@chat_id, @last_message_id, @last_message_timestamp, @last_poll_at, @last_success_at, @last_error)
      ON CONFLICT(chat_id) DO UPDATE SET
        last_message_id = COALESCE(excluded.last_message_id, last_message_id),
        last_message_timestamp = COALESCE(excluded.last_message_timestamp, last_message_timestamp),
        last_poll_at = excluded.last_poll_at,
        last_success_at = COALESCE(excluded.last_success_at, last_success_at),
        last_error = excluded.last_error
    `),
  };

  return {
    get(chatId) {
      return stmts.get.get(chatId) || null;
    },
    list() {
      return stmts.list.all();
    },
    // Record a completed poll attempt for one chat. On error the cursor is
    // never advanced; last_error always reflects the latest attempt.
    record(chatId, { ok, error = null, lastMessageId = null, lastMessageTimestamp = null } = {}) {
      const at = nowIso();
      stmts.upsert.run({
        chat_id: chatId,
        last_message_id: ok ? lastMessageId : null,
        last_message_timestamp: ok ? lastMessageTimestamp : null,
        last_poll_at: at,
        last_success_at: ok ? at : null,
        last_error: ok ? null : String(error ?? '').slice(0, 500),
      });
    },
    // Cursor for incremental fetching (only from successful polls).
    cursor(chatId) {
      const row = stmts.get.get(chatId);
      if (!row || row.last_error || !row.last_message_id) return null;
      return {
        lastMessageId: row.last_message_id,
        lastMessageTimestamp: row.last_message_timestamp,
      };
    },
  };
}
