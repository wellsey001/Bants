import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'media'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'bants.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  about         TEXT NOT NULL DEFAULT '',
  avatar_media  TEXT,
  friend_code   TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER,
  is_admin      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT '',
  push_token  TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS contact_requests (
  id         INTEGER PRIMARY KEY,
  from_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(from_user, to_user)
);

CREATE TABLE IF NOT EXISTS contacts (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('direct','group')),
  name         TEXT,
  avatar_media TEXT,
  direct_key   TEXT UNIQUE,          -- "smallId:largeId" for direct chats
  disappear_after INTEGER NOT NULL DEFAULT 0, -- seconds; 0 = messages stay
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  joined_at       INTEGER NOT NULL,
  last_delivered  INTEGER NOT NULL DEFAULT 0,
  last_read       INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  client_id       TEXT,
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','video','audio','file','sticker','system')),
  body            TEXT NOT NULL DEFAULT '',
  media_id        TEXT,
  reply_to        INTEGER,
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted         INTEGER NOT NULL DEFAULT 0,
  meta            TEXT,               -- JSON: mentions, link preview
  expires_at      INTEGER,            -- disappearing messages
  UNIQUE(sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS stickers (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, media_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  filename    TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
`);

// ───────────── upgrades for databases made by older versions ─────────────

const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  if (!hasColumn('messages', 'meta')) {
    // SQLite can't change a CHECK constraint, so rebuild the messages table to allow stickers.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE messages_new (
        id              INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        client_id       TEXT,
        kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','video','audio','file','sticker','system')),
        body            TEXT NOT NULL DEFAULT '',
        media_id        TEXT,
        reply_to        INTEGER,
        created_at      INTEGER NOT NULL,
        edited_at       INTEGER,
        deleted         INTEGER NOT NULL DEFAULT 0,
        meta            TEXT,
        expires_at      INTEGER,
        UNIQUE(sender_id, client_id)
      );
      INSERT INTO messages_new (id, conversation_id, sender_id, client_id, kind, body, media_id, reply_to, created_at, edited_at, deleted)
        SELECT id, conversation_id, sender_id, client_id, kind, body, media_id, reply_to, created_at, edited_at, deleted FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  if (!hasColumn('users', 'is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('members', 'pinned')) db.exec('ALTER TABLE members ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('members', 'archived')) db.exec('ALTER TABLE members ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('conversations', 'disappear_after')) db.exec('ALTER TABLE conversations ADD COLUMN disappear_after INTEGER NOT NULL DEFAULT 0');
  db.exec('PRAGMA user_version = 1');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL');
// Messages their sender unsent. Kept (ids only, no content) so phones that were offline remove them too.
db.exec(`CREATE TABLE IF NOT EXISTS unsent (
  message_id      INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  at              INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_unsent_conv ON unsent(conversation_id, message_id)');

// The first account on the server runs it.
if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
  db.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const cache = new Map();
/** Cached prepared statement. */
export function q(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}
