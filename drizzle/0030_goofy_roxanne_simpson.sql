CREATE TABLE "project_review_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_review_id" uuid NOT NULL,
	"source_appeal_id" uuid,
	"requested_by" text NOT NULL,
	"request_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"reason" text NOT NULL,
	"source_commit_sha" text NOT NULL,
	"source_analyzer_version" text NOT NULL,
	"source_rubric_version" text NOT NULL,
	"source_provenance" jsonb NOT NULL,
	"source_findings_hash" text NOT NULL,
	"target_analyzer_version" text NOT NULL,
	"target_rubric_version" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"result_findings" jsonb,
	"result_findings_hash" text,
	"result_provenance" jsonb,
	"evidence" jsonb,
	"evidence_hash" text,
	"projection_applied" boolean,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_review_correction_revision_positive" CHECK ("project_review_correction"."revision" >= 1),
	CONSTRAINT "project_review_correction_reason_length" CHECK (char_length("project_review_correction"."reason") BETWEEN 20 AND 2000),
	CONSTRAINT "project_review_correction_source_sha" CHECK ("project_review_correction"."source_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "project_review_correction_source_hash" CHECK ("project_review_correction"."source_findings_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_review_correction_result_hash" CHECK ("project_review_correction"."result_findings_hash" IS NULL OR "project_review_correction"."result_findings_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_review_correction_evidence_hash" CHECK ("project_review_correction"."evidence_hash" IS NULL OR "project_review_correction"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_review_correction_source_provenance" CHECK (jsonb_typeof("project_review_correction"."source_provenance") = 'object'),
	CONSTRAINT "project_review_correction_result_findings" CHECK ("project_review_correction"."result_findings" IS NULL OR jsonb_typeof("project_review_correction"."result_findings") = 'array'),
	CONSTRAINT "project_review_correction_result_provenance" CHECK ("project_review_correction"."result_provenance" IS NULL OR jsonb_typeof("project_review_correction"."result_provenance") = 'object'),
	CONSTRAINT "project_review_correction_evidence_object" CHECK ("project_review_correction"."evidence" IS NULL OR jsonb_typeof("project_review_correction"."evidence") = 'object'),
	CONSTRAINT "project_review_correction_status" CHECK ("project_review_correction"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "project_review_correction_completed_shape" CHECK (("project_review_correction"."status" <> 'succeeded') OR (
        "project_review_correction"."result_findings" IS NOT NULL
        AND "project_review_correction"."result_findings_hash" IS NOT NULL
        AND "project_review_correction"."result_provenance" IS NOT NULL
        AND "project_review_correction"."evidence" IS NOT NULL
        AND "project_review_correction"."evidence_hash" IS NOT NULL
        AND "project_review_correction"."projection_applied" IS NOT NULL
        AND "project_review_correction"."completed_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "project_review_correction_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correction_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_role" text NOT NULL,
	"event" text NOT NULL,
	"request_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_review_correction_event_actor" CHECK ("project_review_correction_event"."actor_role" IN ('admin', 'system')),
	CONSTRAINT "project_review_correction_event_type" CHECK ("project_review_correction_event"."event" IN ('queued', 'analysis_started', 'analysis_succeeded', 'analysis_failed', 'projection_applied', 'projection_skipped')),
	CONSTRAINT "project_review_correction_event_reason" CHECK (char_length("project_review_correction_event"."reason") BETWEEN 8 AND 2000),
	CONSTRAINT "project_review_correction_event_evidence" CHECK (jsonb_typeof("project_review_correction_event"."evidence") = 'object'),
	CONSTRAINT "project_review_correction_event_hash" CHECK ("project_review_correction_event"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "project_review_effective" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"source_review_id" uuid NOT NULL,
	"correction_id" uuid,
	"commit_sha" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"rubric_version" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"findings_hash" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_review_effective_sha" CHECK ("project_review_effective"."commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "project_review_effective_provenance" CHECK (jsonb_typeof("project_review_effective"."provenance") = 'object'),
	CONSTRAINT "project_review_effective_findings" CHECK (jsonb_typeof("project_review_effective"."findings") = 'array'),
	CONSTRAINT "project_review_effective_hash" CHECK ("project_review_effective"."findings_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_review_effective_revision" CHECK ("project_review_effective"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "project_review" ADD COLUMN "rubric_version" text DEFAULT 'static-project-review-rubric-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_review" ADD COLUMN "analysis_provenance" jsonb DEFAULT '{"schemaVersion":1,"analysisMode":"deterministic_static","aiUsed":false,"promptVersion":null,"provider":null,"model":null,"modelCallId":null,"rubricVersion":"static-project-review-rubric-v1","repositoryExecution":"none","runnerTemplateId":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_review" ADD COLUMN "findings_hash" text;--> statement-breakpoint
ALTER TABLE "project_review_correction" ADD CONSTRAINT "project_review_correction_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_correction" ADD CONSTRAINT "project_review_correction_source_review_id_project_review_id_fk" FOREIGN KEY ("source_review_id") REFERENCES "public"."project_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_correction" ADD CONSTRAINT "project_review_correction_source_appeal_id_appeal_id_fk" FOREIGN KEY ("source_appeal_id") REFERENCES "public"."appeal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_correction" ADD CONSTRAINT "project_review_correction_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_correction_event" ADD CONSTRAINT "project_review_correction_event_correction_id_project_review_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."project_review_correction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_correction_event" ADD CONSTRAINT "project_review_correction_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_effective" ADD CONSTRAINT "project_review_effective_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_effective" ADD CONSTRAINT "project_review_effective_source_review_id_project_review_id_fk" FOREIGN KEY ("source_review_id") REFERENCES "public"."project_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_effective" ADD CONSTRAINT "project_review_effective_correction_id_project_review_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."project_review_correction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_review_correction_request_unique" ON "project_review_correction" USING btree ("requested_by","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_review_correction_appeal_unique" ON "project_review_correction" USING btree ("source_appeal_id") WHERE "project_review_correction"."source_appeal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_review_correction_revision_unique" ON "project_review_correction" USING btree ("project_id","revision");--> statement-breakpoint
CREATE INDEX "project_review_correction_queue_idx" ON "project_review_correction" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_review_correction_event_request_unique" ON "project_review_correction_event" USING btree ("correction_id","request_id");--> statement-breakpoint
CREATE INDEX "project_review_correction_event_timeline_idx" ON "project_review_correction_event" USING btree ("correction_id","occurred_at");--> statement-breakpoint
CREATE INDEX "project_review_effective_source_idx" ON "project_review_effective" USING btree ("source_review_id");--> statement-breakpoint
ALTER TABLE "project_review" ADD CONSTRAINT "project_review_provenance_object" CHECK (jsonb_typeof("project_review"."analysis_provenance") = 'object');--> statement-breakpoint
ALTER TABLE "project_review" ADD CONSTRAINT "project_review_findings_array" CHECK (jsonb_typeof("project_review"."findings") = 'array');--> statement-breakpoint
ALTER TABLE "project_review" ADD CONSTRAINT "project_review_findings_hash" CHECK ("project_review"."findings_hash" IS NULL OR "project_review"."findings_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE FUNCTION "protect_project_review_evidence"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."commit_sha" IS DISTINCT FROM OLD."commit_sha"
    OR NEW."analyzer_version" IS DISTINCT FROM OLD."analyzer_version"
    OR NEW."rubric_version" IS DISTINCT FROM OLD."rubric_version"
    OR (NEW."model_call_id" IS DISTINCT FROM OLD."model_call_id" AND NEW."model_call_id" IS NOT NULL)
    OR NEW."analysis_provenance" IS DISTINCT FROM OLD."analysis_provenance"
    OR NEW."findings" IS DISTINCT FROM OLD."findings"
    OR NEW."findings_hash" IS DISTINCT FROM OLD."findings_hash"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'project review evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "project_review_evidence_immutable_trigger"
BEFORE UPDATE ON "project_review"
FOR EACH ROW EXECUTE FUNCTION "protect_project_review_evidence"();--> statement-breakpoint
CREATE FUNCTION "protect_project_review_correction_evidence"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."source_review_id" IS DISTINCT FROM OLD."source_review_id"
    OR (NEW."source_appeal_id" IS DISTINCT FROM OLD."source_appeal_id" AND NEW."source_appeal_id" IS NOT NULL)
    OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
    OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
    OR NEW."revision" IS DISTINCT FROM OLD."revision"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."source_commit_sha" IS DISTINCT FROM OLD."source_commit_sha"
    OR NEW."source_analyzer_version" IS DISTINCT FROM OLD."source_analyzer_version"
    OR NEW."source_rubric_version" IS DISTINCT FROM OLD."source_rubric_version"
    OR NEW."source_provenance" IS DISTINCT FROM OLD."source_provenance"
    OR NEW."source_findings_hash" IS DISTINCT FROM OLD."source_findings_hash"
    OR NEW."target_analyzer_version" IS DISTINCT FROM OLD."target_analyzer_version"
    OR NEW."target_rubric_version" IS DISTINCT FROM OLD."target_rubric_version"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'project review correction source evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'succeeded' AND NEW IS DISTINCT FROM OLD
  THEN
    RAISE EXCEPTION 'completed project review correction evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "project_review_correction_evidence_immutable_trigger"
BEFORE UPDATE ON "project_review_correction"
FOR EACH ROW EXECUTE FUNCTION "protect_project_review_correction_evidence"();--> statement-breakpoint
CREATE FUNCTION "protect_project_review_correction_event_update"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'project review correction events are append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "project_review_correction_event_append_only_trigger"
BEFORE UPDATE ON "project_review_correction_event"
FOR EACH ROW EXECUTE FUNCTION "protect_project_review_correction_event_update"();
