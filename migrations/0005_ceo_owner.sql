-- The existing owner becomes Group CEO. Keep the legacy internal permission key,
-- account ID, credentials, sessions and all other staff assignments intact.
INSERT INTO staff_profiles(user_id,rank_id,department)
SELECT id,'group-ceo','Executive Office' FROM staff_users WHERE role='chairman'
ON CONFLICT(user_id) DO UPDATE SET rank_id=excluded.rank_id;
