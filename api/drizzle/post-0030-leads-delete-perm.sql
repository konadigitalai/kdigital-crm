-- Grant the new `leads.delete` permission to the system groups that already
-- have `leads.write` — Administrators, Advisors, Sales advisor. Idempotent.
--
-- The presets file (post-0025) runs on every migration, but the in-code
-- catalog is the source of truth for *new* tenants. For *existing* tenants
-- whose groups were seeded before this permission existed, this back-fills.

INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, 'leads.delete'
FROM user_group g
JOIN user_group_permission p
  ON p.group_id = g.id AND p.permission = 'leads.write'
WHERE g.is_system = true
  AND g.name IN ('Administrators', 'Advisors', 'Sales advisor')
ON CONFLICT DO NOTHING;
