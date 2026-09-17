export function createSettingsRepo(db) {
  const stmts = {
    get: db.prepare('SELECT value FROM settings WHERE key = ?'),
    set: db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    all: db.prepare('SELECT key, value FROM settings'),
  };

  return {
    get(key, fallback = null) {
      const row = stmts.get.get(key);
      return row ? row.value : fallback;
    },
    set(key, value) {
      stmts.set.run(key, String(value));
    },
    all() {
      return Object.fromEntries(stmts.all.all().map((r) => [r.key, r.value]));
    },
  };
}
