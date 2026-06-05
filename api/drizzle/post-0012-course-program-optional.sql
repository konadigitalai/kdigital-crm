-- Course is no longer required to belong to a program.
-- The program_id column stays for back-compat (used as a tag in admin views),
-- but the NOT NULL constraint is dropped.
-- Idempotent.

ALTER TABLE "course" ALTER COLUMN "program_id" DROP NOT NULL;
