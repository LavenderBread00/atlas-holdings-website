CREATE TABLE IF NOT EXISTS staff_password_resets (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL UNIQUE REFERENCES staff_users(id),
 expires_at INTEGER NOT NULL,
 used_at INTEGER,
 created_at INTEGER NOT NULL
);
