CREATE TABLE "assessment_attempt_effective_result" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"outcome_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"result_hash" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_attempt_effective_result_outcome_id_unique" UNIQUE("outcome_id"),
	CONSTRAINT "assessment_effective_result_json" CHECK (jsonb_typeof("assessment_attempt_effective_result"."result") = 'object'),
	CONSTRAINT "assessment_effective_result_hash" CHECK ("assessment_attempt_effective_result"."result_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_effective_result_revision" CHECK ("assessment_attempt_effective_result"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "assessment_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_appeal_id" uuid,
	"created_by" text NOT NULL,
	"create_request_id" uuid NOT NULL,
	"status" text DEFAULT 'reviewed' NOT NULL,
	"defect_kind" text NOT NULL,
	"reason" text NOT NULL,
	"course_id" text NOT NULL,
	"module_id" text NOT NULL,
	"item_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"content_version" text NOT NULL,
	"faulty_bundle_version" text NOT NULL,
	"faulty_evidence_hash" text NOT NULL,
	"replacement_bundle_version" text NOT NULL,
	"replacement_evidence" jsonb NOT NULL,
	"replacement_evidence_hash" text NOT NULL,
	"review_checklist" jsonb NOT NULL,
	"review_hash" text NOT NULL,
	"affected_count" integer DEFAULT 0 NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_correction_status_check" CHECK ("assessment_correction"."status" IN ('reviewed', 'queued', 'processing', 'completed', 'partially_failed', 'failed')),
	CONSTRAINT "assessment_correction_defect_kind_check" CHECK ("assessment_correction"."defect_kind" IN ('faulty_test', 'ambiguous_oracle', 'runtime_defect')),
	CONSTRAINT "assessment_correction_reason_length" CHECK (char_length("assessment_correction"."reason") BETWEEN 20 AND 2000),
	CONSTRAINT "assessment_correction_hashes_check" CHECK ("assessment_correction"."faulty_evidence_hash" ~ '^[0-9a-f]{64}$' AND "assessment_correction"."replacement_evidence_hash" ~ '^[0-9a-f]{64}$' AND "assessment_correction"."review_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_correction_replacement_object" CHECK (jsonb_typeof("assessment_correction"."replacement_evidence") = 'object'),
	CONSTRAINT "assessment_correction_review_object" CHECK (jsonb_typeof("assessment_correction"."review_checklist") = 'object'),
	CONSTRAINT "assessment_correction_version_change" CHECK ("assessment_correction"."faulty_bundle_version" <> "assessment_correction"."replacement_bundle_version"),
	CONSTRAINT "assessment_correction_affected_count" CHECK ("assessment_correction"."affected_count" >= 0),
	CONSTRAINT "assessment_correction_row_version" CHECK ("assessment_correction"."row_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "assessment_correction_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correction_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_role" text NOT NULL,
	"event" text NOT NULL,
	"request_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_correction_event_actor_role" CHECK ("assessment_correction_event"."actor_role" IN ('admin', 'system')),
	CONSTRAINT "assessment_correction_event_type" CHECK ("assessment_correction_event"."event" IN ('reviewed', 'queued', 'regrade_started', 'regrade_succeeded', 'regrade_failed', 'completed')),
	CONSTRAINT "assessment_correction_event_reason" CHECK (char_length("assessment_correction_event"."reason") BETWEEN 8 AND 2000),
	CONSTRAINT "assessment_correction_event_evidence" CHECK (jsonb_typeof("assessment_correction_event"."evidence") = 'object'),
	CONSTRAINT "assessment_correction_event_hash" CHECK ("assessment_correction_event"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "assessment_correction_impact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correction_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"exam_session_id" uuid,
	"user_id" text NOT NULL,
	"form_id" text NOT NULL,
	"form_hash" text NOT NULL,
	"answer_set_hash" text NOT NULL,
	"original_result_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_correction_impact_hashes" CHECK ("assessment_correction_impact"."form_hash" ~ '^[0-9a-f]{64}$' AND "assessment_correction_impact"."answer_set_hash" ~ '^[0-9a-f]{64}$' AND "assessment_correction_impact"."original_result_hash" ~ '^[0-9a-f]{64}$' AND "assessment_correction_impact"."snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_correction_impact_snapshot" CHECK (jsonb_typeof("assessment_correction_impact"."snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "assessment_mastery_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outcome_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"skill_id" text NOT NULL,
	"language_context" text DEFAULT 'conceptual' NOT NULL,
	"effect" text NOT NULL,
	"prior_outcome" text NOT NULL,
	"corrected_outcome" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_mastery_adjustment_effect" CHECK ("assessment_mastery_adjustment"."effect" IN ('award', 'revoke', 'no_change')),
	CONSTRAINT "assessment_mastery_adjustment_outcomes" CHECK ("assessment_mastery_adjustment"."prior_outcome" IN ('NOT_PASSED', 'PASSED', 'MASTERED', 'PENDING_REVIEW') AND "assessment_mastery_adjustment"."corrected_outcome" IN ('NOT_PASSED', 'PASSED', 'MASTERED', 'PENDING_REVIEW')),
	CONSTRAINT "assessment_mastery_adjustment_evidence" CHECK (jsonb_typeof("assessment_mastery_adjustment"."evidence") = 'object'),
	CONSTRAINT "assessment_mastery_adjustment_hash" CHECK ("assessment_mastery_adjustment"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "assessment_regrade_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correction_id" uuid NOT NULL,
	"impact_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_regrade_job_attempt_count" CHECK ("assessment_regrade_job"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assessment_regrade_outcome" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correction_id" uuid NOT NULL,
	"impact_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"revision" integer NOT NULL,
	"supersedes_outcome_id" uuid,
	"original_result" jsonb NOT NULL,
	"original_result_hash" text NOT NULL,
	"corrected_result" jsonb NOT NULL,
	"corrected_result_hash" text NOT NULL,
	"runner_evidence" jsonb NOT NULL,
	"runner_evidence_hash" text NOT NULL,
	"decision_evidence" jsonb NOT NULL,
	"decision_evidence_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_regrade_outcome_revision" CHECK ("assessment_regrade_outcome"."revision" >= 1),
	CONSTRAINT "assessment_regrade_outcome_hashes" CHECK ("assessment_regrade_outcome"."original_result_hash" ~ '^[0-9a-f]{64}$' AND "assessment_regrade_outcome"."corrected_result_hash" ~ '^[0-9a-f]{64}$' AND "assessment_regrade_outcome"."runner_evidence_hash" ~ '^[0-9a-f]{64}$' AND "assessment_regrade_outcome"."decision_evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_regrade_outcome_json" CHECK (jsonb_typeof("assessment_regrade_outcome"."original_result") = 'object' AND jsonb_typeof("assessment_regrade_outcome"."corrected_result") = 'object' AND jsonb_typeof("assessment_regrade_outcome"."runner_evidence") = 'object' AND jsonb_typeof("assessment_regrade_outcome"."decision_evidence") = 'object')
);
--> statement-breakpoint
ALTER TABLE "assessment_attempt_effective_result" ADD CONSTRAINT "assessment_attempt_effective_result_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempt_effective_result" ADD CONSTRAINT "assessment_attempt_effective_result_outcome_id_assessment_regrade_outcome_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."assessment_regrade_outcome"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempt_effective_result" ADD CONSTRAINT "assessment_attempt_effective_result_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction" ADD CONSTRAINT "assessment_correction_source_appeal_id_appeal_id_fk" FOREIGN KEY ("source_appeal_id") REFERENCES "public"."appeal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction" ADD CONSTRAINT "assessment_correction_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction_event" ADD CONSTRAINT "assessment_correction_event_correction_id_assessment_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."assessment_correction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction_event" ADD CONSTRAINT "assessment_correction_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction_impact" ADD CONSTRAINT "assessment_correction_impact_correction_id_assessment_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."assessment_correction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction_impact" ADD CONSTRAINT "assessment_correction_impact_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction_impact" ADD CONSTRAINT "assessment_correction_impact_exam_session_id_exam_session_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_correction_impact" ADD CONSTRAINT "assessment_correction_impact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_adjustment" ADD CONSTRAINT "assessment_mastery_adjustment_outcome_id_assessment_regrade_outcome_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."assessment_regrade_outcome"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_adjustment" ADD CONSTRAINT "assessment_mastery_adjustment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_mastery_adjustment" ADD CONSTRAINT "assessment_mastery_adjustment_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_regrade_job" ADD CONSTRAINT "assessment_regrade_job_correction_id_assessment_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."assessment_correction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_regrade_job" ADD CONSTRAINT "assessment_regrade_job_impact_id_assessment_correction_impact_id_fk" FOREIGN KEY ("impact_id") REFERENCES "public"."assessment_correction_impact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_regrade_outcome" ADD CONSTRAINT "assessment_regrade_outcome_correction_id_assessment_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."assessment_correction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_regrade_outcome" ADD CONSTRAINT "assessment_regrade_outcome_impact_id_assessment_correction_impact_id_fk" FOREIGN KEY ("impact_id") REFERENCES "public"."assessment_correction_impact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_regrade_outcome" ADD CONSTRAINT "assessment_regrade_outcome_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_regrade_outcome" ADD CONSTRAINT "assessment_regrade_outcome_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_effective_result_user_idx" ON "assessment_attempt_effective_result" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_correction_create_request_unique" ON "assessment_correction" USING btree ("created_by","create_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_correction_scope_replacement_unique" ON "assessment_correction" USING btree ("course_id","module_id","item_id","content_version","faulty_evidence_hash","replacement_evidence_hash");--> statement-breakpoint
CREATE INDEX "assessment_correction_status_idx" ON "assessment_correction" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_correction_event_request_unique" ON "assessment_correction_event" USING btree ("correction_id","request_id");--> statement-breakpoint
CREATE INDEX "assessment_correction_event_timeline_idx" ON "assessment_correction_event" USING btree ("correction_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_correction_impact_attempt_unique" ON "assessment_correction_impact" USING btree ("correction_id","attempt_id");--> statement-breakpoint
CREATE INDEX "assessment_correction_impact_user_idx" ON "assessment_correction_impact" USING btree ("user_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_mastery_adjustment_outcome_skill_unique" ON "assessment_mastery_adjustment" USING btree ("outcome_id","skill_id","language_context");--> statement-breakpoint
CREATE INDEX "assessment_mastery_adjustment_user_idx" ON "assessment_mastery_adjustment" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_regrade_job_impact_unique" ON "assessment_regrade_job" USING btree ("impact_id");--> statement-breakpoint
CREATE INDEX "assessment_regrade_job_queue_idx" ON "assessment_regrade_job" USING btree ("status","queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_regrade_outcome_correction_attempt_unique" ON "assessment_regrade_outcome" USING btree ("correction_id","attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_regrade_outcome_attempt_revision_unique" ON "assessment_regrade_outcome" USING btree ("attempt_id","revision");--> statement-breakpoint
CREATE INDEX "assessment_regrade_outcome_attempt_idx" ON "assessment_regrade_outcome" USING btree ("attempt_id","created_at");
--> statement-breakpoint
ALTER TABLE "assessment_regrade_outcome"
  ADD CONSTRAINT "assessment_regrade_outcome_supersedes_fk"
  FOREIGN KEY ("supersedes_outcome_id")
  REFERENCES "assessment_regrade_outcome"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION "protect_assessment_correction_identity"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR (NEW."source_appeal_id" IS DISTINCT FROM OLD."source_appeal_id" AND NEW."source_appeal_id" IS NOT NULL)
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."create_request_id" IS DISTINCT FROM OLD."create_request_id"
    OR NEW."defect_kind" IS DISTINCT FROM OLD."defect_kind"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."course_id" IS DISTINCT FROM OLD."course_id"
    OR NEW."module_id" IS DISTINCT FROM OLD."module_id"
    OR NEW."item_id" IS DISTINCT FROM OLD."item_id"
    OR NEW."skill_id" IS DISTINCT FROM OLD."skill_id"
    OR NEW."content_version" IS DISTINCT FROM OLD."content_version"
    OR NEW."faulty_bundle_version" IS DISTINCT FROM OLD."faulty_bundle_version"
    OR NEW."faulty_evidence_hash" IS DISTINCT FROM OLD."faulty_evidence_hash"
    OR NEW."replacement_bundle_version" IS DISTINCT FROM OLD."replacement_bundle_version"
    OR NEW."replacement_evidence" IS DISTINCT FROM OLD."replacement_evidence"
    OR NEW."replacement_evidence_hash" IS DISTINCT FROM OLD."replacement_evidence_hash"
    OR NEW."review_checklist" IS DISTINCT FROM OLD."review_checklist"
    OR NEW."review_hash" IS DISTINCT FROM OLD."review_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'assessment correction scope, replacement, and review evidence are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "assessment_correction_identity_trigger"
BEFORE UPDATE ON "assessment_correction"
FOR EACH ROW EXECUTE FUNCTION "protect_assessment_correction_identity"();
--> statement-breakpoint
CREATE FUNCTION "reject_assessment_correction_evidence_update"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'assessment correction evidence is append-only'
    USING ERRCODE = '23514';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "assessment_correction_event_append_only_trigger"
BEFORE UPDATE ON "assessment_correction_event"
FOR EACH ROW EXECUTE FUNCTION "reject_assessment_correction_evidence_update"();
--> statement-breakpoint
CREATE TRIGGER "assessment_correction_impact_append_only_trigger"
BEFORE UPDATE ON "assessment_correction_impact"
FOR EACH ROW EXECUTE FUNCTION "reject_assessment_correction_evidence_update"();
--> statement-breakpoint
CREATE TRIGGER "assessment_regrade_outcome_append_only_trigger"
BEFORE UPDATE ON "assessment_regrade_outcome"
FOR EACH ROW EXECUTE FUNCTION "reject_assessment_correction_evidence_update"();
--> statement-breakpoint
CREATE TRIGGER "assessment_mastery_adjustment_append_only_trigger"
BEFORE UPDATE ON "assessment_mastery_adjustment"
FOR EACH ROW EXECUTE FUNCTION "reject_assessment_correction_evidence_update"();
