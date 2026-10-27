PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS staff_users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('chairman','staff')), active INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_one_chairman ON staff_users(role) WHERE role='chairman';
CREATE TABLE IF NOT EXISTS staff_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES staff_users(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_invites (
 token_hash TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
 expires_at INTEGER NOT NULL, used_at INTEGER, created_by TEXT NOT NULL REFERENCES staff_users(id)
);
CREATE TABLE IF NOT EXISTS staff_announcements (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
 author_id TEXT NOT NULL REFERENCES staff_users(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_resources (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
