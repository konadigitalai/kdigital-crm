CREATE TABLE IF NOT EXISTS "agent_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text NOT NULL,
	"badge_label" text NOT NULL,
	"badge_kind" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_assignment_badge_kind_check" CHECK ("agent_assignment"."badge_kind" IN ('run','done'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_score_signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"text" text NOT NULL,
	"weight" text NOT NULL,
	"kind" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "lead_score_signal_kind_check" CHECK ("lead_score_signal"."kind" IN ('pos','neg','neu'))
);
--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "source_label" text;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "score_label" text;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "score_desc" text;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "advisor_id" uuid;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "nba_confidence" integer;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "nba_headline" text;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "nba_why" text;--> statement-breakpoint
ALTER TABLE "party" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "party" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "party" ADD COLUMN "city" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_assignment" ADD CONSTRAINT "agent_assignment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_assignment" ADD CONSTRAINT "agent_assignment_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_assignment" ADD CONSTRAINT "agent_assignment_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_score_signal" ADD CONSTRAINT "lead_score_signal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_score_signal" ADD CONSTRAINT "lead_score_signal_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_assignment_uniq" ON "agent_assignment" USING btree ("work_item_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_assignment_wi_idx" ON "agent_assignment" USING btree ("tenant_id","work_item_id","rank");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_score_signal_wi_idx" ON "lead_score_signal" USING btree ("tenant_id","work_item_id","rank");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead" ADD CONSTRAINT "lead_advisor_id_app_user_id_fk" FOREIGN KEY ("advisor_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_advisor_idx" ON "lead" USING btree ("tenant_id","advisor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_email_idx" ON "party" USING btree ("tenant_id","email");