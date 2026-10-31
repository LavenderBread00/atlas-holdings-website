-- Explicit feature access replaces the shared Management switch. Existing
-- custom ranks keep their previous access; saved permission edits survive reruns.
CREATE TABLE IF NOT EXISTS staff_rank_permissions (
 rank_id TEXT PRIMARY KEY REFERENCES staff_ranks(id) ON DELETE CASCADE,
 view_directory INTEGER NOT NULL DEFAULT 0 CHECK(view_directory IN (0,1)),
 view_all_tasks INTEGER NOT NULL DEFAULT 0 CHECK(view_all_tasks IN (0,1)),
 manage_tasks INTEGER NOT NULL DEFAULT 0 CHECK(manage_tasks IN (0,1)),
 manage_announcements INTEGER NOT NULL DEFAULT 0 CHECK(manage_announcements IN (0,1)),
 manage_resources INTEGER NOT NULL DEFAULT 0 CHECK(manage_resources IN (0,1))
);
INSERT OR IGNORE INTO staff_rank_permissions
 (rank_id,view_directory,view_all_tasks,manage_tasks,manage_announcements,manage_resources)
SELECT id,management,
 CASE WHEN id='deputy-company-secretary' THEN 0 ELSE management END,
 CASE WHEN id IN ('group-company-secretary','deputy-company-secretary') THEN 0 ELSE management END,
 CASE WHEN id IN ('group-cfo','group-cto','deputy-company-secretary') THEN 0 ELSE management END,
 management
FROM staff_ranks;
