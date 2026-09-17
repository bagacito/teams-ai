export function createEventRepo(db) {
  const stmts = {
    insert: db.prepare('INSERT OR IGNORE INTO processed_events (id) VALUES (?)'),
    exists: db.prepare('SELECT 1 FROM processed_events WHERE id = ?'),
  };

  return {
    // Returns true if this event id was seen for the first time (should process).
    firstTimeSeen(eventId) {
      if (!eventId) return true;
      return stmts.insert.run(eventId).changes > 0;
    },
    seen(eventId) {
      return stmts.exists.get(eventId) !== undefined;
    },
  };
}
