-- Private learner notes, pinned to a point in a lesson.
--
-- "Notes are private and stay pinned to the timestamp" — a learner writes at
-- 12:00 into a video and finds it again at 12:00. Distinct from
-- module_resource.kind='note', which is trainer-authored material everyone
-- sees; this is the learner's own and nobody else's, trainers included.
--
-- Scoping is the route's job, as everywhere else in the LMS: RLS here is
-- tenant-only and would happily return another learner's notes. Every read
-- and write filters on the caller's party_id.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS learner_note (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  party_id         uuid NOT NULL REFERENCES party(id),
  resource_id      uuid NOT NULL REFERENCES module_resource(id) ON DELETE CASCADE,
  -- Where in the lesson the note was taken. 0 for non-timed material (a
  -- reading has no playhead), which is why there is no NOT NULL default
  -- beyond zero and no uniqueness on it — several notes per second is fine.
  position_seconds integer NOT NULL DEFAULT 0,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_note_position_check CHECK (position_seconds >= 0),
  CONSTRAINT learner_note_body_check     CHECK (length(btrim(body)) > 0)
);

-- The only read pattern: this learner's notes on this lesson, in playback
-- order. Composite covers it without a second index.
CREATE INDEX IF NOT EXISTS learner_note_party_resource_idx
  ON learner_note (party_id, resource_id, position_seconds);
CREATE INDEX IF NOT EXISTS learner_note_tenant_idx
  ON learner_note (tenant_id, party_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON learner_note TO decrm_app;

ALTER TABLE learner_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_note FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learner_note_tenant_isolation ON learner_note;
CREATE POLICY learner_note_tenant_isolation ON learner_note
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);
