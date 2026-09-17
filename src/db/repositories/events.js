export function createEventRepo(db) {
  const stmts = {
    insert: db.prepare('INSERT OR IGNORE INTO processed_events (id, message_id) VALUES (?, ?)'),
    exists: db.prepare('SELECT 1 FROM processed_events WHERE id = ?'),
  };

  return {
    // Returns true if this event id was seen for the first time (should process).
    // Power Automate may retry; event ids dedupe those retries.
    firstTimeSeen(eventId, messageId = null) {
      if (!eventId) return true;
      return stmts.insert.run(eventId, messageId).changes > 0;
    },
    seen(eventId) {
      return stmts.exists.get(eventId) !== undefined;
    },
  };
}
