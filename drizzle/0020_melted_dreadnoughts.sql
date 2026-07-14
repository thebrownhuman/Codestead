CREATE TABLE "assessment_mastery_projection_repair" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"course_id" text NOT NULL,
	"module_id" text NOT NULL,
	"content_version" text NOT NULL,
	"skill_id" text NOT NULL,
	"language_context" text DEFAULT 'conceptual' NOT NULL,
	"effect" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"concept_id" uuid,
	"enrollment_id" uuid,
	"projection_evidence_id" uuid,
	"before_projection" jsonb,
	"after_projection" jsonb,
	"applied_row_version" bigint,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"resolution_code" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_mastery_projection_repair_adjustment_id_unique" UNIQUE("adjustment_id"),
	CONSTRAINT "assessment_mastery_projection_repair_effect" CHECK ("assessment_mastery_projection_repair"."effect" IN ('award', 'revoke', 'no_change')),
	CONSTRAINT "assessment_mastery_projection_repair_status" CHECK ("assessment_mastery_projection_repair"."status" IN ('pending', 'applied', 'unresolved')),
	CONSTRAINT "assessment_mastery_projection_repair_attempt_count" CHECK ("assessment_mastery_projection_repair"."attempt_count" >= 0),
	CONSTRAINT "assessment_mastery_projection_repair_before_json" CHECK ("assessment_mastery_projection_repair"."before_projection" IS NULL OR jsonb_typeof("assessment_mastery_projection_repair"."before_projection") = 'object'),
	CONSTRAINT "assessment_mastery_projection_repair_after_json" CHECK ("assessment_mastery_projection_repair"."after_projection" IS NULL OR jsonb_typeof("assessment_mastery_projection_repair"."after_projection") = 'object'),
	CONSTRAINT "assessment_mastery_projection_repair_applied_state" CHECK (("assessment_mastery_projection_repair"."status" <> 'applied') OR ("assessment_mastery_projection_repair"."applied_at" IS NOT NULL AND "assessment_mastery_projection_repair"."resolution_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "assessment_correction_event" DROP CONSTRAINT "assessment_correction_event_type";--> statement-breakpoint
ALTER TABLE "assessment_mastery_projection_repair" ADD CONSTRAINT "assessment_mastery_projection_repair_adjustment_id_assessment_mastery_adjustment_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."assessment_mastery_adjustment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_projection_repair" ADD CONSTRAINT "assessment_mastery_projection_repair_outcome_id_assessment_regrade_outcome_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."assessment_regrade_outcome"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_projection_repair" ADD CONSTRAINT "assessment_mastery_projection_repair_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_projection_repair" ADD CONSTRAINT "assessment_mastery_projection_repair_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_projection_repair" ADD CONSTRAINT "assessment_mastery_projection_repair_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_projection_repair" ADD CONSTRAINT "assessment_mastery_projection_repair_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_projection_repair" ADD CONSTRAINT "assessment_mastery_projection_repair_projection_evidence_id_mastery_evidence_id_fk" FOREIGN KEY ("projection_evidence_id") REFERENCES "public"."mastery_evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_mastery_projection_repair_queue_idx" ON "assessment_mastery_projection_repair" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "assessment_mastery_projection_repair_user_idx" ON "assessment_mastery_projection_repair" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "assessment_mastery_projection_repair_attempt_skill_idx" ON "assessment_mastery_projection_repair" USING btree ("attempt_id","skill_id","language_context");--> statement-breakpoint
ALTER TABLE "assessment_correction_event" ADD CONSTRAINT "assessment_correction_event_type" CHECK ("assessment_correction_event"."event" IN ('reviewed', 'queued', 'regrade_started', 'regrade_succeeded', 'regrade_failed', 'mastery_projection_applied', 'mastery_projection_unresolved', 'completed'));