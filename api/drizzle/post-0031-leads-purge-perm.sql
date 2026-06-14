-- Grant the new `leads.purge` permission (permanent deletion of soft-deleted
-- leads) to the Administrators system group only. Idempotent.

INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, 'leads.purge'
FROM user_group g
WHERE g.is_system = true AND g.name = 'Administrators'
ON CONFLICT DO NOTHING;
