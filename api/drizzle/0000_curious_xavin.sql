CREATE TABLE IF NOT EXISTS "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid,
	"party_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"channel" text,
	"verb" text NOT NULL,
	"detail" text,
	"tag" text,
	"icon_key" text,
	"icon_bg" text,
	"icon_stroke" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"operates_on" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "agent_domain_check" CHECK ("agent"."domain" IN ('sales','service'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_run" (
	"work_item_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_key" text NOT NULL,
	"run_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"target" text,
	"metric_label" text,
	"metric_value" text,
	"right_pill" text,
	"glyph" text,
	"icon_key" text,
	"desc" text,
	"live" boolean DEFAULT false,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"auth0_sub" text,
	"email" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'advisor' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_role_check" CHECK ("app_user"."role" IN ('admin','advisor','service_rep','readonly'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid,
	"action_type" text NOT NULL,
	"mode" text DEFAULT 'supervised' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed" jsonb NOT NULL,
	"requested_by" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_mode_check" CHECK ("approval"."mode" IN ('auto','supervised','manual')),
	CONSTRAINT "approval_status_check" CHECK ("approval"."status" IN ('pending','approved','rejected','expired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_policy" (
	"tenant_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "approval_policy_mode_check" CHECK ("approval_policy"."mode" IN ('auto','supervised','manual'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_item_id" uuid,
	"party_id" uuid,
	"kind" text,
	"blob_url" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"model" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cohort" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date,
	"seats" integer,
	"price" numeric(12, 2),
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deal" (
	"work_item_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cohort_id" uuid,
	"value" numeric(12, 2),
	"probability" integer,
	CONSTRAINT "deal_probability_check" CHECK ("deal"."probability" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid,
	"chunk" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrolment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"deal_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrolment_status_check" CHECK ("enrolment"."status" IN ('active','completed','dropped','deferred'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead" (
	"work_item_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text,
	"score" integer,
	"score_reason" text,
	"heat" text,
	"city" text,
	"program" text,
	"cohort" text,
	"value" text,
	"stage" text,
	"stage_label" text,
	"avatar" text,
	"initials" text,
	"nba_icon" text,
	"nba_label" text,
	"nba_ghost" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding_task" (
	"work_item_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"enrolment_id" uuid,
	"step" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text DEFAULT 'person' NOT NULL,
	"name" text NOT NULL,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_kind_check" CHECK ("party"."kind" IN ('person','org'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" text NOT NULL,
	"valid_from" date DEFAULT now() NOT NULL,
	"valid_to" date,
	CONSTRAINT "party_role_role_check" CHECK ("party_role"."role" IN ('lead','contact','learner','advisor','alumnus'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "program" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"track" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"rel_type" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" uuid NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_case" (
	"work_item_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" text,
	"channel" text,
	"csat" integer,
	CONSTRAINT "service_case_csat_check" CHECK ("service_case"."csat" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region" text DEFAULT 'india' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type" text NOT NULL,
	"party_id" uuid,
	"assignee_id" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 3 NOT NULL,
	"sla_due" timestamp with time zone,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_type_check" CHECK ("work_item"."type" IN ('lead','deal','service_case','onboarding_task','agent_run'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent" ADD CONSTRAINT "agent_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval" ADD CONSTRAINT "approval_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval" ADD CONSTRAINT "approval_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval" ADD CONSTRAINT "approval_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_policy" ADD CONSTRAINT "approval_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachment" ADD CONSTRAINT "attachment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachment" ADD CONSTRAINT "attachment_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachment" ADD CONSTRAINT "attachment_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cohort" ADD CONSTRAINT "cohort_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cohort" ADD CONSTRAINT "cohort_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deal" ADD CONSTRAINT "deal_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deal" ADD CONSTRAINT "deal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deal" ADD CONSTRAINT "deal_cohort_id_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohort"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embedding" ADD CONSTRAINT "embedding_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_cohort_id_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohort"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_deal_id_work_item_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."work_item"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead" ADD CONSTRAINT "lead_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead" ADD CONSTRAINT "lead_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_task" ADD CONSTRAINT "onboarding_task_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_task" ADD CONSTRAINT "onboarding_task_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_task" ADD CONSTRAINT "onboarding_task_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolment"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "party" ADD CONSTRAINT "party_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "party_role" ADD CONSTRAINT "party_role_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "party_role" ADD CONSTRAINT "party_role_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "program" ADD CONSTRAINT "program_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationship" ADD CONSTRAINT "relationship_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_case" ADD CONSTRAINT "service_case_work_item_id_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_case" ADD CONSTRAINT "service_case_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_item" ADD CONSTRAINT "work_item_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_item" ADD CONSTRAINT "work_item_assignee_id_app_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_wi_idx" ON "activity" USING btree ("tenant_id","work_item_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_party_idx" ON "activity" USING btree ("tenant_id","party_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_gin" ON "activity" USING gin ("payload");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tenant_key_key" ON "agent" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_key_idx" ON "agent_run" USING btree ("agent_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_user_auth0_sub_key" ON "app_user" USING btree ("auth0_sub") WHERE "app_user"."auth0_sub" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_user_tenant_email_key" ON "app_user" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_queue_idx" ON "approval" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_policy_pk" ON "approval_policy" USING btree ("tenant_id","action_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachment_wi_idx" ON "attachment" USING btree ("tenant_id","work_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_tenant_ts_idx" ON "audit_log" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cohort_tenant_program_idx" ON "cohort" USING btree ("tenant_id","program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embedding_scope_idx" ON "embedding" USING btree ("tenant_id","object_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrolment_party_idx" ON "enrolment" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrolment_cohort_idx" ON "enrolment" USING btree ("tenant_id","cohort_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_tenant_idx" ON "party" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_identifiers_gin" ON "party" USING gin ("identifiers");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_name_trgm" ON "party" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_role_lookup_idx" ON "party_role" USING btree ("tenant_id","role","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "party_role_party_valid_key" ON "party_role" USING btree ("party_id","role","valid_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_from_idx" ON "relationship" USING btree ("tenant_id","from_type","from_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_to_idx" ON "relationship" USING btree ("tenant_id","to_type","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rel_unique_idx" ON "relationship" USING btree ("tenant_id","from_type","from_id","rel_type","to_type","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_item_tenant_number_key" ON "work_item" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wi_tenant_type_state_idx" ON "work_item" USING btree ("tenant_id","type","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wi_assignee_idx" ON "work_item" USING btree ("tenant_id","assignee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wi_party_idx" ON "work_item" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wi_sla_idx" ON "work_item" USING btree ("tenant_id","sla_due");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wi_attributes_gin" ON "work_item" USING gin ("attributes");