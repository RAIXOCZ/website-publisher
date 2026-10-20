'use strict';

// SQLite via Node's built-in node:sqlite (no native dependency).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const config = require('./config');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,  -- the ADMIN_EMAIL account
  created_at TEXT NOT NULL,
  created_ip TEXT,
  deleted_at TEXT,
  deleted_by TEXT,            -- 'user' or 'admin'
  purge_after TEXT,           -- personal data is erased after this
  purged_at TEXT
);
-- One active account per e-mail; deleted accounts keep their row until purged.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active ON users(email) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  password_hash TEXT,         -- only for password sites published from whitelisted IPs
  salt TEXT,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  trash_dir TEXT,             -- where the files of a deleted site are kept
  purge_after TEXT,
  purged_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sites_name_active ON sites(name) WHERE deleted_at IS NULL;

-- One-time links sent by e-mail (login, publish confirmation, account deletion).
CREATE TABLE IF NOT EXISTS email_tokens (
  hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  email TEXT NOT NULL,
  user_id INTEGER,
  payload TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  site_id INTEGER,
  site_name TEXT,
  action TEXT NOT NULL,
  ip TEXT,
  detail TEXT                 -- JSON; may contain e-mail addresses (admin only)
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS audit_site ON audit_log(site_id);

CREATE TABLE IF NOT EXISTS previews (
  code TEXT PRIMARY KEY,
  user_id INTEGER,
  ip TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_whitelist (
  ip TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

function open() {
  if (db) return db;
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  db = new DatabaseSync(config.DB_FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Columns added after the first release.
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  return db;
}

const now = () => new Date().toISOString();
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const inDays = (days) => inMinutes(days * 24 * 60);

// Small helpers so callers stay short: one(sql, ...args), all(...), run(...).
const one = (sql, ...args) => open().prepare(sql).get(...args) ?? null;
const all = (sql, ...args) => open().prepare(sql).all(...args);
const run = (sql, ...args) => open().prepare(sql).run(...args);

function transaction(fn) {
  const d = open();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, one, all, run, transaction, now, inMinutes, inDays };
