CREATE TABLE "exam_finalization_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_finalization_job_status_check" CHECK ("exam_finalization_job"."status" in ('scheduled','leased','succeeded','failed')),
	CONSTRAINT "exam_finalization_job_attempt_count_check" CHECK ("exam_finalization_job"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exam_mastery_recheck" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_attempt_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"content_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"target_cluster_ids" text[] NOT NULL,
	"target_coding_item_ids" text[] NOT NULL,
	"recheck_attempt_id" uuid,
	"completed_at" timestamp with time zone,
	"result_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_mastery_recheck_status_check" CHECK ("exam_mastery_recheck"."status" in ('scheduled','available','active','completed')),
	CONSTRAINT "exam_mastery_recheck_targets_check" CHECK (cardinality("exam_mastery_recheck"."target_cluster_ids") + cardinality("exam_mastery_recheck"."target_coding_item_ids") > 0),
	CONSTRAINT "exam_mastery_recheck_state_shape_check" CHECK (
		("status" in ('scheduled','available') and "recheck_attempt_id" is null and "completed_at" is null and "result_outcome" is null)
		or ("status" = 'active' and "recheck_attempt_id" is not null and "completed_at" is null and "result_outcome" is null)
		or ("status" = 'completed' and "recheck_attempt_id" is not null and "completed_at" is not null and "result_outcome" in ('NOT_PASSED','PASSED','MASTERED','PENDING_REVIEW'))
	)
);
--> statement-breakpoint
CREATE TABLE "exam_reexam_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"source_exam_session_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"granted_by_user_id" text,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"consumed_by_attempt_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_reexam_grant_status_check" CHECK ("exam_reexam_grant"."status" in ('available','consumed','revoked')),
	CONSTRAINT "exam_reexam_grant_reason_check" CHECK (char_length("exam_reexam_grant"."reason") between 20 and 2000),
	CONSTRAINT "exam_reexam_grant_evidence_check" CHECK (jsonb_typeof("exam_reexam_grant"."evidence") = 'object'),
	CONSTRAINT "exam_reexam_grant_hash_check" CHECK ("exam_reexam_grant"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "exam_reexam_grant_state_shape_check" CHECK (
		("status" = 'available' and "consumed_by_attempt_id" is null and "consumed_at" is null)
		or ("status" = 'consumed' and "consumed_by_attempt_id" is not null and "consumed_at" is not null)
		or ("status" = 'revoked' and "consumed_by_attempt_id" is null and "consumed_at" is null)
	)
);
--> statement-breakpoint
CREATE FUNCTION "exam_reexam_grant_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.request_id IS DISTINCT FROM OLD.request_id
		OR NEW.user_id IS DISTINCT FROM OLD.user_id
		OR NEW.source_exam_session_id IS DISTINCT FROM OLD.source_exam_session_id
		OR NEW.module_id IS DISTINCT FROM OLD.module_id
		OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
		OR NEW.reason IS DISTINCT FROM OLD.reason
		OR NEW.evidence IS DISTINCT FROM OLD.evidence
		OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'exam re-exam grant source/evidence is immutable' USING ERRCODE = '23514';
	END IF;
	IF OLD.status IN ('consumed','revoked') AND (
		NEW.status IS DISTINCT FROM OLD.status
		OR NEW.consumed_by_attempt_id IS DISTINCT FROM OLD.consumed_by_attempt_id
		OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
	) THEN
		RAISE EXCEPTION 'terminal exam re-exam grant is immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "exam_reexam_grant_immutable"
BEFORE UPDATE ON "exam_reexam_grant"
FOR EACH ROW EXECUTE FUNCTION "exam_reexam_grant_immutable_guard"();
--> statement-breakpoint
CREATE FUNCTION "exam_mastery_recheck_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.user_id IS DISTINCT FROM OLD.user_id
		OR NEW.source_attempt_id IS DISTINCT FROM OLD.source_attempt_id
		OR NEW.module_id IS DISTINCT FROM OLD.module_id
		OR NEW.content_version IS DISTINCT FROM OLD.content_version
		OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
		OR NEW.due_at IS DISTINCT FROM OLD.due_at
		OR NEW.target_cluster_ids IS DISTINCT FROM OLD.target_cluster_ids
		OR NEW.target_coding_item_ids IS DISTINCT FROM OLD.target_coding_item_ids
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'exam mastery recheck source/targets are immutable' USING ERRCODE = '23514';
	END IF;
	IF OLD.recheck_attempt_id IS NOT NULL
		AND NEW.recheck_attempt_id IS DISTINCT FROM OLD.recheck_attempt_id THEN
		RAISE EXCEPTION 'exam mastery recheck attempt binding is immutable' USING ERRCODE = '23514';
	END IF;
	IF OLD.status = 'completed' AND NEW IS DISTINCT FROM OLD THEN
		RAISE EXCEPTION 'completed exam mastery recheck is immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "exam_mastery_recheck_immutable"
BEFORE UPDATE ON "exam_mastery_recheck"
FOR EACH ROW EXECUTE FUNCTION "exam_mastery_recheck_immutable_guard"();
--> statement-breakpoint
ALTER TABLE "exam_finalization_job" ADD CONSTRAINT "exam_finalization_job_exam_session_id_exam_session_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_mastery_recheck" ADD CONSTRAINT "exam_mastery_recheck_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_mastery_recheck" ADD CONSTRAINT "exam_mastery_recheck_source_attempt_id_attempt_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_mastery_recheck" ADD CONSTRAINT "exam_mastery_recheck_recheck_attempt_id_attempt_id_fk" FOREIGN KEY ("recheck_attempt_id") REFERENCES "public"."attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_reexam_grant" ADD CONSTRAINT "exam_reexam_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_reexam_grant" ADD CONSTRAINT "exam_reexam_grant_source_exam_session_id_exam_session_id_fk" FOREIGN KEY ("source_exam_session_id") REFERENCES "public"."exam_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_reexam_grant" ADD CONSTRAINT "exam_reexam_grant_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_reexam_grant" ADD CONSTRAINT "exam_reexam_grant_consumed_by_attempt_id_attempt_id_fk" FOREIGN KEY ("consumed_by_attempt_id") REFERENCES "public"."attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_finalization_job_session_unique" ON "exam_finalization_job" USING btree ("exam_session_id");--> statement-breakpoint
CREATE INDEX "exam_finalization_job_due_idx" ON "exam_finalization_job" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_mastery_recheck_source_unique" ON "exam_mastery_recheck" USING btree ("source_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_mastery_recheck_attempt_unique" ON "exam_mastery_recheck" USING btree ("recheck_attempt_id");--> statement-breakpoint
CREATE INDEX "exam_mastery_recheck_user_due_idx" ON "exam_mastery_recheck" USING btree ("user_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_reexam_grant_request_unique" ON "exam_reexam_grant" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_reexam_grant_source_unique" ON "exam_reexam_grant" USING btree ("source_exam_session_id");--> statement-breakpoint
CREATE INDEX "exam_reexam_grant_available_idx" ON "exam_reexam_grant" USING btree ("user_id","module_id","status");
