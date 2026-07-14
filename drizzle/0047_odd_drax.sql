CREATE TABLE "career_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"technology" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"future_scope" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"authored_by" text NOT NULL,
	"published_by" text,
	"market_claim" text,
	"market_source_url" text,
	"market_region" text,
	"market_observed_at" timestamp with time zone,
	"market_reviewed_at" timestamp with time zone,
	"market_expires_at" timestamp with time zone,
	"market_reviewed_by" text,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_card_slug_check" CHECK ("career_card"."slug" ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
	CONSTRAINT "career_card_path_length" CHECK (char_length("career_card"."path") BETWEEN 2 AND 120),
	CONSTRAINT "career_card_technology_length" CHECK (char_length("career_card"."technology") BETWEEN 1 AND 120),
	CONSTRAINT "career_card_title_length" CHECK (char_length("career_card"."title") BETWEEN 3 AND 160),
	CONSTRAINT "career_card_summary_length" CHECK (char_length("career_card"."summary") BETWEEN 20 AND 1200),
	CONSTRAINT "career_card_future_scope_length" CHECK (char_length("career_card"."future_scope") BETWEEN 20 AND 2000),
	CONSTRAINT "career_card_status_check" CHECK ("career_card"."status" IN ('draft', 'published', 'retired')),
	CONSTRAINT "career_card_version_check" CHECK ("career_card"."row_version" >= 1),
	CONSTRAINT "career_card_publish_shape" CHECK (("career_card"."status" <> 'published') OR ("career_card"."published_by" IS NOT NULL AND "career_card"."published_at" IS NOT NULL AND "career_card"."retired_at" IS NULL)),
	CONSTRAINT "career_card_retire_shape" CHECK (("career_card"."status" <> 'retired') OR "career_card"."retired_at" IS NOT NULL),
	CONSTRAINT "career_card_market_all_or_none" CHECK (("career_card"."market_claim" IS NULL AND "career_card"."market_source_url" IS NULL AND "career_card"."market_region" IS NULL
          AND "career_card"."market_observed_at" IS NULL AND "career_card"."market_reviewed_at" IS NULL
          AND "career_card"."market_expires_at" IS NULL AND "career_card"."market_reviewed_by" IS NULL)
        OR ("career_card"."market_claim" IS NOT NULL AND "career_card"."market_source_url" IS NOT NULL AND "career_card"."market_region" IS NOT NULL
          AND "career_card"."market_observed_at" IS NOT NULL AND "career_card"."market_reviewed_at" IS NOT NULL
          AND "career_card"."market_expires_at" IS NOT NULL AND "career_card"."market_reviewed_by" IS NOT NULL)),
	CONSTRAINT "career_card_market_metadata_check" CHECK ("career_card"."market_claim" IS NULL OR (
        char_length("career_card"."market_claim") BETWEEN 10 AND 1000
        AND char_length("career_card"."market_region") BETWEEN 2 AND 120
        AND char_length("career_card"."market_source_url") BETWEEN 12 AND 2000
        AND "career_card"."market_source_url" ~ '^https://[^[:space:]]+$'
        AND "career_card"."market_observed_at" <= "career_card"."market_reviewed_at"
        AND "career_card"."market_reviewed_at" < "career_card"."market_expires_at"
      )),
	CONSTRAINT "career_card_published_market_freshness" CHECK ("career_card"."status" <> 'published' OR "career_card"."market_claim" IS NULL OR (
        "career_card"."market_reviewed_at" <= "career_card"."published_at" AND "career_card"."published_at" < "career_card"."market_expires_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "career_card_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"career_card_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"event" text NOT NULL,
	"input_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"reason" text NOT NULL,
	"resulting_version" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_card_event_type_check" CHECK ("career_card_event"."event" IN ('created', 'updated', 'published', 'retired')),
	CONSTRAINT "career_card_event_input_hash_check" CHECK ("career_card_event"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "career_card_event_evidence_hash_check" CHECK ("career_card_event"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "career_card_event_snapshot_check" CHECK (jsonb_typeof("career_card_event"."snapshot") = 'object'),
	CONSTRAINT "career_card_event_reason_length" CHECK (char_length("career_card_event"."reason") BETWEEN 8 AND 1000),
	CONSTRAINT "career_card_event_version_check" CHECK ("career_card_event"."resulting_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "career_card_prerequisite" (
	"career_card_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_card_prerequisite_career_card_id_course_id_pk" PRIMARY KEY("career_card_id","course_id"),
	CONSTRAINT "career_card_prerequisite_position_check" CHECK ("career_card_prerequisite"."position" BETWEEN 1 AND 50),
	CONSTRAINT "career_card_prerequisite_rationale_length" CHECK (char_length("career_card_prerequisite"."rationale") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE TABLE "certificate_operation_receipt" (
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"input_hash" text NOT NULL,
	"certificate_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificate_operation_receipt_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "certificate_operation_receipt_operation_check" CHECK ("certificate_operation_receipt"."operation" = 'issue'),
	CONSTRAINT "certificate_operation_receipt_input_hash" CHECK ("certificate_operation_receipt"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "certificate_operation_receipt_result_object" CHECK (jsonb_typeof("certificate_operation_receipt"."result") = 'object')
);
--> statement-breakpoint
CREATE TABLE "certificate_revocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certificate_id" uuid NOT NULL,
	"revoked_by" text NOT NULL,
	"request_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificate_revocation_reason_length" CHECK (char_length("certificate_revocation"."reason") BETWEEN 8 AND 1000),
	CONSTRAINT "certificate_revocation_evidence_hash" CHECK ("certificate_revocation"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "course_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"course_version_id" uuid NOT NULL,
	"verification_id" text NOT NULL,
	"learner_display_name" text NOT NULL,
	"course_title" text NOT NULL,
	"course_version_label" text NOT NULL,
	"issue_evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_certificate_verification_shape" CHECK ("course_certificate"."verification_id" ~ '^[A-Za-z0-9_-]{32,80}$'),
	CONSTRAINT "course_certificate_learner_name_length" CHECK (char_length("course_certificate"."learner_display_name") BETWEEN 1 AND 160),
	CONSTRAINT "course_certificate_course_title_length" CHECK (char_length("course_certificate"."course_title") BETWEEN 1 AND 300),
	CONSTRAINT "course_certificate_version_length" CHECK (char_length("course_certificate"."course_version_label") BETWEEN 1 AND 100),
	CONSTRAINT "course_certificate_evidence_object" CHECK (jsonb_typeof("course_certificate"."issue_evidence") = 'object'),
	CONSTRAINT "course_certificate_evidence_hash" CHECK ("course_certificate"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "course_certificate_policy_length" CHECK (char_length("course_certificate"."policy_version") BETWEEN 3 AND 100)
);
--> statement-breakpoint
CREATE TABLE "public_portfolio" (
	"user_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"headline" text NOT NULL,
	"about" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_portfolio_slug_check" CHECK ("public_portfolio"."slug" ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
	CONSTRAINT "public_portfolio_display_name_length" CHECK (char_length("public_portfolio"."display_name") BETWEEN 1 AND 120),
	CONSTRAINT "public_portfolio_headline_length" CHECK (char_length("public_portfolio"."headline") BETWEEN 10 AND 180),
	CONSTRAINT "public_portfolio_about_length" CHECK ("public_portfolio"."about" IS NULL OR char_length("public_portfolio"."about") BETWEEN 1 AND 1200),
	CONSTRAINT "public_portfolio_version_check" CHECK ("public_portfolio"."row_version" >= 1),
	CONSTRAINT "public_portfolio_publish_shape" CHECK (NOT "public_portfolio"."is_published" OR ("public_portfolio"."published_at" IS NOT NULL AND "public_portfolio"."withdrawn_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "public_portfolio_achievement" (
	"user_id" text NOT NULL,
	"user_achievement_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_portfolio_achievement_user_id_user_achievement_id_pk" PRIMARY KEY("user_id","user_achievement_id"),
	CONSTRAINT "public_portfolio_achievement_position_check" CHECK ("public_portfolio_achievement"."position" BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE "public_portfolio_certificate" (
	"user_id" text NOT NULL,
	"certificate_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_portfolio_certificate_user_id_certificate_id_pk" PRIMARY KEY("user_id","certificate_id"),
	CONSTRAINT "public_portfolio_certificate_position_check" CHECK ("public_portfolio_certificate"."position" BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE "public_portfolio_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"event" text NOT NULL,
	"input_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"reason" text NOT NULL,
	"resulting_version" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_portfolio_event_type_check" CHECK ("public_portfolio_event"."event" IN ('created', 'updated', 'published', 'withdrawn')),
	CONSTRAINT "public_portfolio_event_input_hash" CHECK ("public_portfolio_event"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "public_portfolio_event_evidence_hash" CHECK ("public_portfolio_event"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "public_portfolio_event_snapshot_object" CHECK (jsonb_typeof("public_portfolio_event"."snapshot") = 'object'),
	CONSTRAINT "public_portfolio_event_reason_length" CHECK (char_length("public_portfolio_event"."reason") BETWEEN 8 AND 1000),
	CONSTRAINT "public_portfolio_event_version_check" CHECK ("public_portfolio_event"."resulting_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "public_portfolio_project" (
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_portfolio_project_user_id_project_id_pk" PRIMARY KEY("user_id","project_id"),
	CONSTRAINT "public_portfolio_project_position_check" CHECK ("public_portfolio_project"."position" BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE "career_card" ADD CONSTRAINT "career_card_authored_by_user_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_card" ADD CONSTRAINT "career_card_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_card" ADD CONSTRAINT "career_card_market_reviewed_by_user_id_fk" FOREIGN KEY ("market_reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_card_event" ADD CONSTRAINT "career_card_event_career_card_id_career_card_id_fk" FOREIGN KEY ("career_card_id") REFERENCES "public"."career_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_card_event" ADD CONSTRAINT "career_card_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_card_prerequisite" ADD CONSTRAINT "career_card_prerequisite_career_card_id_career_card_id_fk" FOREIGN KEY ("career_card_id") REFERENCES "public"."career_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_card_prerequisite" ADD CONSTRAINT "career_card_prerequisite_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_operation_receipt" ADD CONSTRAINT "certificate_operation_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_certificate_id_user_unique" ON "course_certificate" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_id_user_unique" ON "project" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_achievement_id_user_unique" ON "user_achievement" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "certificate_operation_receipt" ADD CONSTRAINT "certificate_operation_receipt_certificate_owner_fk" FOREIGN KEY ("certificate_id","user_id") REFERENCES "public"."course_certificate"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_revocation" ADD CONSTRAINT "certificate_revocation_certificate_id_course_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."course_certificate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_revocation" ADD CONSTRAINT "certificate_revocation_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificate" ADD CONSTRAINT "course_certificate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificate" ADD CONSTRAINT "course_certificate_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificate" ADD CONSTRAINT "course_certificate_enrollment_owner_fk" FOREIGN KEY ("enrollment_id","user_id") REFERENCES "public"."enrollment"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio" ADD CONSTRAINT "public_portfolio_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_achievement" ADD CONSTRAINT "public_portfolio_achievement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_achievement" ADD CONSTRAINT "public_portfolio_achievement_owner_fk" FOREIGN KEY ("user_achievement_id","user_id") REFERENCES "public"."user_achievement"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_certificate" ADD CONSTRAINT "public_portfolio_certificate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_certificate" ADD CONSTRAINT "public_portfolio_certificate_owner_fk" FOREIGN KEY ("certificate_id","user_id") REFERENCES "public"."course_certificate"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_event" ADD CONSTRAINT "public_portfolio_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_event" ADD CONSTRAINT "public_portfolio_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_project" ADD CONSTRAINT "public_portfolio_project_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_project" ADD CONSTRAINT "public_portfolio_project_owner_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."project"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "career_card_slug_unique" ON "career_card" USING btree (lower("slug"));--> statement-breakpoint
CREATE INDEX "career_card_status_title_idx" ON "career_card" USING btree ("status","technology","title");--> statement-breakpoint
CREATE UNIQUE INDEX "career_card_event_request_unique" ON "career_card_event" USING btree ("actor_user_id","request_id");--> statement-breakpoint
CREATE INDEX "career_card_event_timeline_idx" ON "career_card_event" USING btree ("career_card_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "career_card_prerequisite_position_unique" ON "career_card_prerequisite" USING btree ("career_card_id","position");--> statement-breakpoint
CREATE INDEX "career_card_prerequisite_course_idx" ON "career_card_prerequisite" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "certificate_operation_receipt_time_idx" ON "certificate_operation_receipt" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_revocation_certificate_unique" ON "certificate_revocation" USING btree ("certificate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_revocation_request_unique" ON "certificate_revocation" USING btree ("revoked_by","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "course_certificate_verification_unique" ON "course_certificate" USING btree ("verification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "course_certificate_enrollment_unique" ON "course_certificate" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "course_certificate_user_time_idx" ON "course_certificate" USING btree ("user_id","issued_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "public_portfolio_slug_unique" ON "public_portfolio" USING btree (lower("slug"));--> statement-breakpoint
CREATE INDEX "public_portfolio_published_idx" ON "public_portfolio" USING btree ("is_published","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "public_portfolio_achievement_position_unique" ON "public_portfolio_achievement" USING btree ("user_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "public_portfolio_certificate_position_unique" ON "public_portfolio_certificate" USING btree ("user_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "public_portfolio_event_request_unique" ON "public_portfolio_event" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "public_portfolio_event_timeline_idx" ON "public_portfolio_event" USING btree ("user_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "public_portfolio_project_position_unique" ON "public_portfolio_project" USING btree ("user_id","position");--> statement-breakpoint

CREATE FUNCTION "career_card_authority_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "user" actor
     WHERE actor.id = NEW.authored_by AND actor.role = 'admin' AND actor.status = 'active'
  ) THEN
    RAISE EXCEPTION 'career card author must be an active administrator' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.authored_by <> OLD.authored_by THEN
    RAISE EXCEPTION 'career card author is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.market_claim IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "user" reviewer
     WHERE reviewer.id = NEW.market_reviewed_by AND reviewer.role = 'admin' AND reviewer.status = 'active'
  ) THEN
    RAISE EXCEPTION 'market claim reviewer must be an active administrator' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'published' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "user" publisher
       WHERE publisher.id = NEW.published_by AND publisher.role = 'admin' AND publisher.status = 'active'
    ) THEN
      RAISE EXCEPTION 'career card publisher must be an active administrator' USING ERRCODE = '23514';
    END IF;
    IF NEW.market_claim IS NOT NULL AND NEW.market_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'market claim review has expired' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM career_card_prerequisite prerequisite
        LEFT JOIN curriculum_publication_pointer pointer
          ON pointer.course_id = prerequisite.course_id
        LEFT JOIN course_version version
          ON version.id = pointer.current_course_version_id
       WHERE prerequisite.career_card_id = NEW.id
         AND (version.id IS NULL OR version.stage <> 'verified'
              OR version.published_at IS NULL OR version.approved_by IS NULL)
    ) THEN
      RAISE EXCEPTION 'career prerequisites must point to current verified course versions' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "career_card_authority_guard_trigger"
BEFORE INSERT OR UPDATE ON "career_card"
FOR EACH ROW EXECUTE FUNCTION "career_card_authority_guard"();--> statement-breakpoint

CREATE FUNCTION "certificate_issue_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  concept_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM enrollment enrolled
      JOIN "user" learner ON learner.id = enrolled.user_id
      JOIN course_version version ON version.id = enrolled.course_version_id
      JOIN curriculum_publication_pointer pointer
        ON pointer.course_id = version.course_id
       AND pointer.current_course_version_id = version.id
     WHERE enrolled.id = NEW.enrollment_id
       AND enrolled.user_id = NEW.user_id
       AND enrolled.course_version_id = NEW.course_version_id
       AND enrolled.status = 'completed'
       AND enrolled.completed_at IS NOT NULL
       AND learner.status = 'active'
       AND learner.role = 'learner'
       AND version.stage = 'verified'
       AND version.approved_by IS NOT NULL
       AND version.published_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM curriculum_release_evidence release
          WHERE release.course_version_id = version.id
       )
       AND EXISTS (
         SELECT 1 FROM curriculum_artifact artifact
          WHERE artifact.course_version_id = version.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM curriculum_artifact artifact
          WHERE artifact.course_version_id = version.id
            AND artifact.review_status <> 'approved'
       )
  ) THEN
    RAISE EXCEPTION 'certificate requires an active learner and a completed current verified course version' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO concept_count
    FROM (
      SELECT DISTINCT link.concept_id
        FROM course_module module
        JOIN lesson ON lesson.module_id = module.id
        JOIN lesson_concept link ON link.lesson_id = lesson.id
       WHERE module.course_version_id = NEW.course_version_id
    ) covered;
  IF concept_count = 0 THEN
    RAISE EXCEPTION 'certificate course has no covered concepts' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        SELECT DISTINCT link.concept_id, concept.critical
          FROM course_module module
          JOIN lesson ON lesson.module_id = module.id
          JOIN lesson_concept link ON link.lesson_id = lesson.id
          JOIN concept ON concept.id = link.concept_id
         WHERE module.course_version_id = NEW.course_version_id
      ) covered
     WHERE NOT EXISTS (
       SELECT 1 FROM concept_mastery mastery
        WHERE mastery.user_id = NEW.user_id
          AND mastery.enrollment_id = NEW.enrollment_id
          AND mastery.concept_id = covered.concept_id
          AND mastery.status = 'mastered'
          AND (NOT covered.critical OR mastery.critical_requirements_met)
          AND EXISTS (
            SELECT 1 FROM mastery_evidence evidence
             WHERE evidence.user_id = NEW.user_id
               AND evidence.enrollment_id = NEW.enrollment_id
               AND evidence.concept_id = covered.concept_id
               AND evidence.validity = 'valid'
          )
     )
  ) THEN
    RAISE EXCEPTION 'certificate requires mastered concepts backed by valid evidence' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "certificate_issue_guard_trigger"
BEFORE INSERT ON "course_certificate"
FOR EACH ROW EXECUTE FUNCTION "certificate_issue_guard"();--> statement-breakpoint

CREATE FUNCTION "certificate_revocation_authority_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "user" actor
     WHERE actor.id = NEW.revoked_by AND actor.role = 'admin' AND actor.status = 'active'
  ) THEN
    RAISE EXCEPTION 'certificate revocation requires an active administrator' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "certificate_revocation_authority_guard_trigger"
BEFORE INSERT ON "certificate_revocation"
FOR EACH ROW EXECUTE FUNCTION "certificate_revocation_authority_guard"();--> statement-breakpoint

CREATE FUNCTION "public_portfolio_selection_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'public_portfolio_project' AND NOT EXISTS (
    SELECT 1 FROM project owned
     WHERE owned.id = NEW.project_id AND owned.user_id = NEW.user_id
       AND owned.github_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'
  ) THEN
    RAISE EXCEPTION 'portfolio project requires an owner-bound public GitHub repository URL' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'public_portfolio_achievement' AND NOT EXISTS (
    SELECT 1 FROM user_achievement owned
     WHERE owned.id = NEW.user_achievement_id AND owned.user_id = NEW.user_id
       AND owned.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'portfolio achievement must be current and owner-bound' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'public_portfolio_certificate' AND NOT EXISTS (
    SELECT 1 FROM course_certificate owned
     WHERE owned.id = NEW.certificate_id AND owned.user_id = NEW.user_id
       AND NOT EXISTS (
         SELECT 1 FROM certificate_revocation revoked WHERE revoked.certificate_id = owned.id
       )
  ) THEN
    RAISE EXCEPTION 'portfolio certificate must be current and owner-bound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "public_portfolio_project_selection_guard_trigger"
BEFORE INSERT OR UPDATE ON "public_portfolio_project"
FOR EACH ROW EXECUTE FUNCTION "public_portfolio_selection_guard"();--> statement-breakpoint
CREATE TRIGGER "public_portfolio_achievement_selection_guard_trigger"
BEFORE INSERT OR UPDATE ON "public_portfolio_achievement"
FOR EACH ROW EXECUTE FUNCTION "public_portfolio_selection_guard"();--> statement-breakpoint
CREATE TRIGGER "public_portfolio_certificate_selection_guard_trigger"
BEFORE INSERT OR UPDATE ON "public_portfolio_certificate"
FOR EACH ROW EXECUTE FUNCTION "public_portfolio_selection_guard"();--> statement-breakpoint

CREATE FUNCTION "career_certificate_history_append_only"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.account_deletion_authorized', true) = '1' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "career_card_event_append_only_trigger"
BEFORE UPDATE OR DELETE ON "career_card_event"
FOR EACH ROW EXECUTE FUNCTION "career_certificate_history_append_only"();--> statement-breakpoint
CREATE TRIGGER "course_certificate_append_only_trigger"
BEFORE UPDATE OR DELETE ON "course_certificate"
FOR EACH ROW EXECUTE FUNCTION "career_certificate_history_append_only"();--> statement-breakpoint
CREATE TRIGGER "certificate_revocation_append_only_trigger"
BEFORE UPDATE OR DELETE ON "certificate_revocation"
FOR EACH ROW EXECUTE FUNCTION "career_certificate_history_append_only"();--> statement-breakpoint
CREATE TRIGGER "certificate_operation_receipt_append_only_trigger"
BEFORE UPDATE OR DELETE ON "certificate_operation_receipt"
FOR EACH ROW EXECUTE FUNCTION "career_certificate_history_append_only"();--> statement-breakpoint
CREATE TRIGGER "public_portfolio_event_append_only_trigger"
BEFORE UPDATE OR DELETE ON "public_portfolio_event"
FOR EACH ROW EXECUTE FUNCTION "career_certificate_history_append_only"();
