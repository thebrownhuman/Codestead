CREATE TABLE "appeal_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appeal_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_role" text NOT NULL,
	"event" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeal_event_actor_role_check" CHECK ("appeal_event"."actor_role" IN ('learner', 'admin', 'system')),
	CONSTRAINT "appeal_event_type_check" CHECK ("appeal_event"."event" IN ('submitted', 'needs_learner_input', 'upheld', 'overturned', 'closed')),
	CONSTRAINT "appeal_event_reason_length" CHECK (char_length("appeal_event"."reason") BETWEEN 8 AND 2000),
	CONSTRAINT "appeal_event_evidence_object_check" CHECK (jsonb_typeof("appeal_event"."evidence") = 'object')
);
--> statement-breakpoint
ALTER TABLE "appeal" ADD COLUMN "category" text DEFAULT 'scoring' NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal" ADD COLUMN "submission_request_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal" ADD COLUMN "evidence_hash" text DEFAULT repeat('0', 64) NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal" ADD COLUMN "row_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal_event" ADD CONSTRAINT "appeal_event_appeal_id_appeal_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."appeal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal_event" ADD CONSTRAINT "appeal_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_event_request_unique" ON "appeal_event" USING btree ("appeal_id","client_request_id");--> statement-breakpoint
CREATE INDEX "appeal_event_timeline_idx" ON "appeal_event" USING btree ("appeal_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_submission_request_unique" ON "appeal" USING btree ("user_id","submission_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_open_attempt_unique" ON "appeal" USING btree ("attempt_id") WHERE "appeal"."attempt_id" IS NOT NULL AND "appeal"."status" IN ('open', 'needs_learner_input', 'under_review');--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_open_project_review_unique" ON "appeal" USING btree ("project_review_id") WHERE "appeal"."project_review_id" IS NOT NULL AND "appeal"."status" IN ('open', 'needs_learner_input', 'under_review');--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_target_check" CHECK ((CASE WHEN "appeal"."attempt_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "appeal"."project_review_id" IS NULL THEN 0 ELSE 1 END) = 1);--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_category_check" CHECK ("appeal"."category" IN ('scoring', 'technical', 'integrity', 'accessibility', 'project_finding'));--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_status_check" CHECK ("appeal"."status" IN ('open', 'under_review', 'needs_learner_input', 'upheld', 'overturned', 'closed'));--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_decision_check" CHECK ("appeal"."decision" IS NULL OR "appeal"."decision" IN ('needs_learner_input', 'upheld', 'overturned'));--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_evidence_hash_check" CHECK ("appeal"."evidence_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_evidence_object_check" CHECK (jsonb_typeof("appeal"."evidence") = 'object');--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_row_version_check" CHECK ("appeal"."row_version" >= 1);