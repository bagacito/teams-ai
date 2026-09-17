export function createUserRepo(db) {
  const stmts = {
    insert: db.prepare(
      'INSERT INTO allowed_users (entra_user_id, display_name, enabled) VALUES (?, ?, ?)',
    ),
    all: db.prepare('SELECT * FROM allowed_users ORDER BY created_at DESC'),
    get: db.prepare('SELECT * FROM allowed_users WHERE id = ?'),
    byEntraId: db.prepare('SELECT * FROM allowed_users WHERE entra_user_id = ?'),
    setEnabled: db.prepare('UPDATE allowed_users SET enabled = ? WHERE id = ?'),
    rename: db.prepare('UPDATE allowed_users SET display_name = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM allowed_users WHERE id = ?'),
  };

  return {
    add(entraUserId, displayName = '', enabled = true) {
      const info = stmts.insert.run(entraUserId.trim(), displayName.trim(), enabled ? 1 : 0);
      return stmts.get.get(info.lastInsertRowid);
    },
    list() {
      return stmts.all.all();
    },
    get(id) {
      return stmts.get.get(id);
    },
    getByEntraId(entraUserId) {
      return stmts.byEntraId.get(entraUserId);
    },
    setEnabled(id, enabled) {
      stmts.setEnabled.run(enabled ? 1 : 0, id);
    },
    rename(id, displayName) {
      stmts.rename.run(displayName.trim(), id);
    },
    remove(id) {
      stmts.remove.run(id);
    },
  };
}
