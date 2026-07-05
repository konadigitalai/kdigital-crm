-- Course is no longer required to belong to a program.
-- The program_id column stays for back-compat (used as a tag in admin views),
-- but the NOT NULL constraint is dropped.
--
-- On a fresh DB where post-0054 has already removed course.program_id at
-- schema-creation time, this is a no-op.
-- Idempotent.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'course' AND column_name = 'program_id'
  ) THEN
    ALTER TABLE "course" ALTER COLUMN "program_id" DROP NOT NULL;
  END IF;
END $$;
