-- Phase: module-level access presets.
--   - Adds pipeline.write to the existing 'Advisors' system group
--     (so kanban drag-drop works for everyone who already had it).
--   - Seeds 4 new system groups per tenant: Sales advisor, Support rep,
--     Trainer, Reports only.
-- Idempotent. Safe to re-run.

-- 1. Top up the existing 'Advisors' group with pipeline.write where missing.
INSERT INTO "user_group_permission" (group_id, permission)
SELECT g.id, 'pipeline.write'
FROM "user_group" g
WHERE g.name = 'Advisors'
  AND NOT EXISTS (
    SELECT 1 FROM "user_group_permission" p
    WHERE p.group_id = g.id AND p.permission = 'pipeline.write'
  );

-- 2. Seed the 4 new system groups for every existing tenant.
DO $$
DECLARE
  t RECORD;
  gid uuid;
  preset RECORD;
  perm text;
BEGIN
  FOR t IN SELECT id FROM "tenant" LOOP
    FOR preset IN
      SELECT * FROM (VALUES
        (
          'Sales advisor',
          'Lead pipeline + agents + own calendar / leaves.',
          ARRAY[
            'leads.read','leads.write',
            'pipeline.read','pipeline.write',
            'agents.read','agents.run',
            'events.manage.self',
            'leaves.read.self',
            'reports.read'
          ]::text[]
        ),
        (
          'Support rep',
          'Cases + learners + own calendar / leaves.',
          ARRAY[
            'cases.read','cases.write',
            'learners.read','learners.write',
            'events.manage.self',
            'leaves.read.self'
          ]::text[]
        ),
        (
          'Trainer',
          'See the batches you teach on your calendar; read learners.',
          ARRAY[
            'learners.read',
            'events.manage.self',
            'leaves.read.self'
          ]::text[]
        ),
        (
          'Reports only',
          'Read across modules; no edits anywhere.',
          ARRAY[
            'leads.read',
            'pipeline.read',
            'cases.read',
            'learners.read',
            'reports.read',
            'leaves.read.self'
          ]::text[]
        )
      ) AS v(name, description, perms)
    LOOP
      -- Insert (or fetch) the system group for this tenant.
      INSERT INTO "user_group" (tenant_id, name, description, is_system)
      VALUES (t.id, preset.name, preset.description, true)
      ON CONFLICT (tenant_id, name) DO UPDATE
        SET description = EXCLUDED.description,
            is_system   = true
      RETURNING id INTO gid;

      IF gid IS NULL THEN
        SELECT id INTO gid FROM "user_group"
        WHERE tenant_id = t.id AND name = preset.name;
      END IF;

      -- Top up missing permissions; never strip extra ones an admin may have added.
      FOREACH perm IN ARRAY preset.perms LOOP
        INSERT INTO "user_group_permission" (group_id, permission)
        VALUES (gid, perm)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
