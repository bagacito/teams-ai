const VALID_SOURCES = new Set(['manual', 'teams', 'approved_draft', 'edited_draft']);

export function createStyleRepo(db) {
  const stmts = {
    insert: db.prepare(
      'INSERT INTO style_examples (message, source, source_chat_id, enabled) VALUES (?, ?, ?, ?)',
    ),
    enabled: db.prepare(
      'SELECT * FROM style_examples WHERE enabled = 1 ORDER BY LENGTH(message) ASC, id ASC',
    ),
    all: db.prepare('SELECT * FROM style_examples ORDER BY created_at DESC, id DESC'),
    get: db.prepare('SELECT * FROM style_examples WHERE id = ?'),
    exists: db.prepare('SELECT 1 FROM style_examples WHERE message = ?'),
    setEnabled: db.prepare('UPDATE style_examples SET enabled = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM style_examples WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS c FROM style_examples'),
  };

  return {
    add(message, source, sourceChatId = null) {
      const msg = String(message).trim();
      if (!msg) return null;
      if (!VALID_SOURCES.has(source)) throw new Error(`invalid style source: ${source}`);
      if (stmts.exists.get(msg)) return null; // dedupe identical examples
      const info = stmts.insert.run(msg, source, sourceChatId, 1);
      return stmts.get.get(info.lastInsertRowid);
    },
    enabledExamples() {
      return stmts.enabled.all();
    },
    list() {
      return stmts.all.all();
    },
    setEnabled(id, enabled) {
      stmts.setEnabled.run(enabled ? 1 : 0, id);
    },
    remove(id) {
      stmts.remove.run(id);
    },
    count() {
      return stmts.count.get().c;
    },
  };
}
