export function createChatRepo(db) {
  const stmts = {
    insert: db.prepare(
      'INSERT INTO allowed_chats (teams_chat_id, display_name, context, enabled) VALUES (?, ?, ?, ?)',
    ),
    all: db.prepare('SELECT * FROM allowed_chats ORDER BY created_at DESC'),
    get: db.prepare('SELECT * FROM allowed_chats WHERE id = ?'),
    byChatId: db.prepare('SELECT * FROM allowed_chats WHERE teams_chat_id = ?'),
    setEnabled: db.prepare('UPDATE allowed_chats SET enabled = ? WHERE id = ?'),
    update: db.prepare('UPDATE allowed_chats SET display_name = ?, context = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM allowed_chats WHERE id = ?'),
  };

  return {
    add(teamsChatId, displayName = '', context = '', enabled = true) {
      const info = stmts.insert.run(
        teamsChatId.trim(),
        displayName.trim(),
        context,
        enabled ? 1 : 0,
      );
      return stmts.get.get(info.lastInsertRowid);
    },
    list() {
      return stmts.all.all();
    },
    get(id) {
      return stmts.get.get(id);
    },
    getByChatId(teamsChatId) {
      return stmts.byChatId.get(teamsChatId);
    },
    setEnabled(id, enabled) {
      stmts.setEnabled.run(enabled ? 1 : 0, id);
    },
    update(id, { displayName, context }) {
      stmts.update.run(displayName.trim(), context, id);
    },
    remove(id) {
      stmts.remove.run(id);
    },
  };
}
