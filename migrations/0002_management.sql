-- Additive management schema: existing accounts, passwords and roles are preserved.
CREATE TABLE IF NOT EXISTS staff_ranks (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 management INTEGER NOT NULL DEFAULT 0 CHECK(management IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO staff_ranks(id,name,management,sort_order) VALUES
 ('director','Group Director',1,10),('manager','Group Manager',1,20),
 ('supervisor','Supervisor',0,30),('staff','Holdings Staff',0,40),('trainee','Trainee',0,50);
CREATE TABLE IF NOT EXISTS staff_profiles (
 user_id TEXT PRIMARY KEY REFERENCES staff_users(id), rank_id TEXT NOT NULL REFERENCES staff_ranks(id),
 department TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS staff_tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 assignee_id TEXT NOT NULL REFERENCES staff_users(id), created_by TEXT NOT NULL REFERENCES staff_users(id),
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high')),
 due_date TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS staff_tasks_assignee ON staff_tasks(assignee_id,status);
CREATE TABLE IF NOT EXISTS staff_activity (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES staff_users(id),
 action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
