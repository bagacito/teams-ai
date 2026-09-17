import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logging.js';
import { runMigrations } from './migrations.js';

let db = null;

export function getDatabase(dataDir) {
  if (db) return db;
  const dir = dataDir || process.env.DATA_DIR || './data';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'teams-ai.sqlite');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  logger.info({ file }, 'database ready');
  return db;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
