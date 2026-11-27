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
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','video','audio','file','sticker','system','poll','location')),
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
if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  // v2: polls and location messages. Rebuild messages so its CHECK allows the new kinds.
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get().sql;
  if (!sql.includes("'poll'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE messages_new (
        id              INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        client_id       TEXT,
        kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','video','audio','file','sticker','system','poll','location')),
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
      INSERT INTO messages_new SELECT id, conversation_id, sender_id, client_id, kind, body, media_id, reply_to, created_at, edited_at, deleted, meta, expires_at FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS idx_messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  db.exec('PRAGMA user_version = 2');
}

// Poll votes: one row per person per option they picked.
db.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id  INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option_id)
)`);
// When each person's delivered/read pointer moved, so "Message info" can show times.
db.exec(`CREATE TABLE IF NOT EXISTS receipt_log (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('delivered','read')),
  upto            INTEGER NOT NULL,
  at              INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_receipt_log ON receipt_log(conversation_id, user_id, kind, upto)');

db.exec(`CREATE TABLE IF NOT EXISTS unsent (
  message_id      INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  at              INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_unsent_conv ON unsent(conversation_id, message_id)');

// ───────────── Servers (Discord-style communities) ─────────────
// Chats above stay exactly as they were. Servers are a separate area of the app with their own
// channels, roles and messages. Who can do what is worked out in permissions.js.
db.exec(`
CREATE TABLE IF NOT EXISTS servers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon_media    TEXT,
  banner_media  TEXT,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- owner always has every permission
  system_channel_id INTEGER,                                           -- where "X joined" messages go
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname      TEXT,
  joined_at     INTEGER NOT NULL,
  timeout_until INTEGER,                       -- read-only until this time
  position      INTEGER NOT NULL DEFAULT 0,    -- order in the user's server list
  muted         INTEGER NOT NULL DEFAULT 0,    -- no push notifications from this server
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);

-- Every server has one is_default role (@everyone) that everyone has without a member_roles row.
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  colour      INTEGER,                         -- 0xRRGGBB, NULL = no colour
  position    INTEGER NOT NULL DEFAULT 0,      -- higher = more senior
  permissions INTEGER NOT NULL DEFAULT 0,      -- bitfield, see permissions.js
  hoist       INTEGER NOT NULL DEFAULT 0,      -- list members with this role separately
  mentionable INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_default ON roles(server_id) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS server_invites (
  code       TEXT PRIMARY KEY,
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  max_uses   INTEGER NOT NULL DEFAULT 0,       -- 0 = unlimited
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,                          -- NULL = never
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_invites_server ON server_invites(server_id);

CREATE TABLE IF NOT EXISTS server_bans (
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL DEFAULT '',
  banned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

-- Who did what, for moderators.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,                    -- 'member.kick', 'role.update', 'channel.create', ...
  target_id  INTEGER,
  meta       TEXT,                             -- JSON: what changed, reason
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log(server_id, id);

-- Text, voice and announcement channels, categories (other channels point at them) and threads.
CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('text','voice','announcement','category','thread')),
  parent_id   INTEGER REFERENCES channels(id) ON DELETE SET NULL, -- category for channels, channel for threads
  name        TEXT NOT NULL,
  topic       TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  slowmode_s  INTEGER NOT NULL DEFAULT 0,
  nsfw        INTEGER NOT NULL DEFAULT 0,
  voice_limit INTEGER NOT NULL DEFAULT 0,
  sync_perms  INTEGER NOT NULL DEFAULT 1,      -- 1 = use the category's overrides
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,     -- thread starter
  starter_message_id INTEGER,
  archived    INTEGER NOT NULL DEFAULT 0,      -- threads
  locked      INTEGER NOT NULL DEFAULT 0,      -- threads: mods only
  last_message_id INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position);
CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id);

CREATE TABLE IF NOT EXISTS channel_overrides (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','member')),
  target_id   INTEGER NOT NULL,
  allow       INTEGER NOT NULL DEFAULT 0,
  deny        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id          INTEGER PRIMARY KEY,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  client_id   TEXT,
  kind        TEXT NOT NULL DEFAULT 'default' CHECK (kind IN ('default','system','join','thread_created','pin')),
  body        TEXT NOT NULL DEFAULT '',        -- with <@123> <@&45> <#67> tokens
  reply_to    INTEGER,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  pinned_at   INTEGER,
  mentions_everyone INTEGER NOT NULL DEFAULT 0,
  meta        TEXT,                            -- JSON: link preview, system details
  UNIQUE(author_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_messages ON channel_messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_channel_messages_pinned ON channel_messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;

-- Several files per message.
CREATE TABLE IF NOT EXISTS channel_attachments (
  message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media(id),
  position   INTEGER NOT NULL DEFAULT 0,
  spoiler    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, media_id)
);

-- One person can add several different reactions to a message.
CREATE TABLE IF NOT EXISTS channel_reactions (
  message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS channel_mentions (
  message_id  INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','role')),
  target_id   INTEGER NOT NULL,
  PRIMARY KEY (message_id, target_type, target_id)
);

-- Unread = channels.last_message_id > last_read. mention_count drives the red badge.
CREATE TABLE IF NOT EXISTS channel_reads (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read     INTEGER NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
`);
// Who's in which voice channel is kept in memory, not here (it resets on restart, which is fine).

// ───────────── Profiles (Discord-style) ─────────────
// Your main profile: banner, accent colour, pronouns and a custom status.
if (!hasColumn('users', 'banner_media')) db.exec('ALTER TABLE users ADD COLUMN banner_media TEXT');
if (!hasColumn('users', 'accent_colour')) db.exec('ALTER TABLE users ADD COLUMN accent_colour INTEGER');
if (!hasColumn('users', 'pronouns')) db.exec("ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT ''");
if (!hasColumn('users', 'custom_status')) db.exec("ALTER TABLE users ADD COLUMN custom_status TEXT NOT NULL DEFAULT ''");
if (!hasColumn('users', 'status_emoji')) db.exec("ALTER TABLE users ADD COLUMN status_emoji TEXT NOT NULL DEFAULT ''");
// Server profiles: a different avatar, banner, bio and pronouns in each server (nickname was already there).
if (!hasColumn('server_members', 'avatar_media')) db.exec('ALTER TABLE server_members ADD COLUMN avatar_media TEXT');
if (!hasColumn('server_members', 'banner_media')) db.exec('ALTER TABLE server_members ADD COLUMN banner_media TEXT');
if (!hasColumn('server_members', 'bio')) db.exec("ALTER TABLE server_members ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!hasColumn('server_members', 'pronouns')) db.exec("ALTER TABLE server_members ADD COLUMN pronouns TEXT NOT NULL DEFAULT ''");
// Custom emojis: up to 50 per person, static or animated, usable in any server.
db.exec(`CREATE TABLE IF NOT EXISTS user_emojis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_id TEXT NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
)`);
// ── Servers, round two: forums, rules, server emojis, polls, events and webhooks ──
if (!hasColumn('channels', 'is_forum')) db.exec('ALTER TABLE channels ADD COLUMN is_forum INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('servers', 'rules')) db.exec("ALTER TABLE servers ADD COLUMN rules TEXT NOT NULL DEFAULT ''");
if (!hasColumn('servers', 'welcome')) db.exec("ALTER TABLE servers ADD COLUMN welcome TEXT NOT NULL DEFAULT ''");
if (!hasColumn('servers', 'require_rules')) db.exec('ALTER TABLE servers ADD COLUMN require_rules INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('server_members', 'rules_accepted_at')) db.exec('ALTER TABLE server_members ADD COLUMN rules_accepted_at INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS server_emojis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_id TEXT NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (server_id, name)
);
CREATE TABLE IF NOT EXISTS channel_poll_votes (
  message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option)
);
CREATE TABLE IF NOT EXISTS server_events (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  reminded INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_server_events ON server_events(server_id, starts_at);
CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id INTEGER NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('going','interested')),
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_media TEXT,
  token TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
`);
// Notifications per channel: 'all', 'mentions' or 'none'. No row = the server's default.
db.exec(`CREATE TABLE IF NOT EXISTS channel_notify (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('all','mentions','none')),
  PRIMARY KEY (user_id, channel_id)
)`);
// Server emoji ids start high so they never clash with personal ones in <:name:id>.
if (!db.prepare('SELECT 1 FROM sqlite_sequence WHERE name = ?').get('server_emojis')) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('server_emojis', 1000000000)").run();

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
