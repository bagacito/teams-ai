const migrations = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS allowed_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entra_user_id TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS allowed_chats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          teams_chat_id TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL DEFAULT '',
          context TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          teams_message_id TEXT NOT NULL UNIQUE,
          chat_id TEXT NOT NULL,
          sender_id TEXT NOT NULL DEFAULT '',
          sender_name TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          message_type TEXT NOT NULL DEFAULT 'message',
          is_me INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          received_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

        CREATE TABLE IF NOT EXISTS conversation_summaries (
          chat_id TEXT PRIMARY KEY,
          summary TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_message_id TEXT
        );

        CREATE TABLE IF NOT EXISTS style_examples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual','teams','approved_draft','edited_draft')),
          source_chat_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          sender_id TEXT NOT NULL DEFAULT '',
          sender_name TEXT NOT NULL DEFAULT '',
          original_message TEXT NOT NULL DEFAULT '',
          generated_reply TEXT NOT NULL DEFAULT '',
          edited_reply TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','approved','edited','rejected','sending','sent','failed','expired')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          approved_at TEXT,
          sent_at TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
        CREATE INDEX IF NOT EXISTS idx_drafts_source ON drafts(source_message_id);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          teams_chat_id TEXT NOT NULL UNIQUE,
          subscription_id TEXT NOT NULL,
          resource TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          expires_at TEXT NOT NULL,
          last_renewed_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS processed_events (
          id TEXT PRIMARY KEY,
          processed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS admin_auth (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      // Power Automate bridge: outbound tracing + reply threading + message id on events.
      db.exec(`ALTER TABLE drafts ADD COLUMN outbound_request_id TEXT`);
      db.exec(`ALTER TABLE drafts ADD COLUMN sent_teams_message_id TEXT`);
      db.exec(`ALTER TABLE messages ADD COLUMN reply_to TEXT`);
      db.exec(`ALTER TABLE processed_events ADD COLUMN message_id TEXT`);
      db.exec(`DROP TABLE IF EXISTS subscriptions`); // Graph subscriptions removed (Power Automate bridge)
    },
  },
  {
    version: 3,
    up: (db) => {
      // Teams MCP polling: per-chat poll cursors.
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_poll_state (
          chat_id TEXT PRIMARY KEY,
          last_message_id TEXT,
          last_message_timestamp TEXT,
          last_poll_at TEXT,
          last_success_at TEXT,
          last_error TEXT
        );
      `);
      // Power Automate outbound request ids are gone.
      db.exec(`ALTER TABLE drafts DROP COLUMN outbound_request_id`);
    },
  },
];

export function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    });
    tx();
  }
}
