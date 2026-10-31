-- Group positions are separate from company-affiliation tags and Discord bots.
-- New positions are unassigned. Existing people, permissions and custom ranks stay intact.
INSERT OR IGNORE INTO staff_ranks(id,name,management,sort_order) VALUES
 ('group-ceo','Group Chief Executive Officer',1,10),
 ('group-cfo','Group Chief Financial Officer',1,20),
 ('group-coo','Group Chief Operating Officer',1,30),
 ('group-cto','Group Chief Technology Officer',1,40),
 ('group-cso','Group Chief Strategy Officer',1,50),
 ('group-ccso','Group Chief Corporate Services Officer',1,60),
 ('group-company-secretary','Group Company Secretary',1,70),
 ('deputy-company-secretary','Deputy Company Secretary',1,80),
 ('managing-director','Managing Director',1,90);

-- Remove only untouched, unused generic defaults. Assigned or renamed ranks remain available.
DELETE FROM staff_ranks
WHERE ((id='director' AND name='Group Director')
 OR (id='manager' AND name='Group Manager')
 OR (id='supervisor' AND name='Supervisor')
 OR (id='trainee' AND name='Trainee'))
AND NOT EXISTS (SELECT 1 FROM staff_profiles WHERE rank_id=staff_ranks.id);

-- The safe fallback remains standard staff and sits below group leadership.
UPDATE staff_ranks SET sort_order=1000 WHERE id='staff';
