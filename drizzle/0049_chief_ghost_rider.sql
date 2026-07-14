CREATE TABLE "module_project_start_receipt" (
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_project_start_receipt_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "module_project_start_receipt_input_hash" CHECK ("module_project_start_receipt"."input_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "module_project_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_version_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"template_key" text NOT NULL,
	"template_version" text NOT NULL,
	"source_course_content_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"brief" jsonb NOT NULL,
	"stage" "publication_stage" DEFAULT 'draft' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_project_template_module_key_length" CHECK (char_length("module_project_template"."module_key") BETWEEN 2 AND 180),
	CONSTRAINT "module_project_template_key_length" CHECK (char_length("module_project_template"."template_key") BETWEEN 10 AND 500),
	CONSTRAINT "module_project_template_version_length" CHECK (char_length("module_project_template"."template_version") BETWEEN 3 AND 120),
	CONSTRAINT "module_project_template_course_hash" CHECK ("module_project_template"."source_course_content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "module_project_template_content_hash" CHECK ("module_project_template"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "module_project_template_title_length" CHECK (char_length("module_project_template"."title") BETWEEN 3 AND 300),
	CONSTRAINT "module_project_template_brief_object" CHECK (jsonb_typeof("module_project_template"."brief") = 'object'),
	CONSTRAINT "module_project_template_brief_size" CHECK (octet_length("module_project_template"."brief"::text) <= 131072),
	CONSTRAINT "module_project_template_stage_check" CHECK ("module_project_template"."stage" IN ('draft','beta','verified','retired')),
	CONSTRAINT "module_project_template_version_positive" CHECK ("module_project_template"."row_version" >= 1),
	CONSTRAINT "module_project_template_review_shape" CHECK (("module_project_template"."stage" = 'draft' AND "module_project_template"."reviewed_by_user_id" IS NULL AND "module_project_template"."reviewed_at" IS NULL AND "module_project_template"."published_at" IS NULL AND "module_project_template"."retired_at" IS NULL)
        OR ("module_project_template"."stage" IN ('beta','verified') AND "module_project_template"."reviewed_by_user_id" IS NOT NULL AND "module_project_template"."reviewed_at" IS NOT NULL AND "module_project_template"."published_at" IS NOT NULL AND "module_project_template"."retired_at" IS NULL)
        OR ("module_project_template"."stage" = 'retired' AND "module_project_template"."reviewed_by_user_id" IS NOT NULL AND "module_project_template"."reviewed_at" IS NOT NULL AND "module_project_template"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "module_project_template_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"event" text NOT NULL,
	"input_hash" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"resulting_version" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_project_template_event_type" CHECK ("module_project_template_event"."event" IN ('reviewed_beta','promoted_verified','retired')),
	CONSTRAINT "module_project_template_event_input_hash" CHECK ("module_project_template_event"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "module_project_template_event_reason_length" CHECK (char_length("module_project_template_event"."reason") BETWEEN 20 AND 2000),
	CONSTRAINT "module_project_template_event_evidence_object" CHECK (jsonb_typeof("module_project_template_event"."evidence") = 'object'),
	CONSTRAINT "module_project_template_event_evidence_hash" CHECK ("module_project_template_event"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "module_project_template_event_version_positive" CHECK ("module_project_template_event"."resulting_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "assignment_template_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "assignment_content_hash" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "assignment_stage_at_start" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "assignment_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "module_project_start_receipt" ADD CONSTRAINT "module_project_start_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_project_start_receipt" ADD CONSTRAINT "module_project_start_receipt_template_id_module_project_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."module_project_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_project_start_receipt" ADD CONSTRAINT "module_project_start_receipt_project_owner_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."project"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_project_template" ADD CONSTRAINT "module_project_template_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_project_template" ADD CONSTRAINT "module_project_template_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_project_template_event" ADD CONSTRAINT "module_project_template_event_template_id_module_project_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."module_project_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_project_template_event" ADD CONSTRAINT "module_project_template_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_project_start_receipt_project_idx" ON "module_project_start_receipt" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "module_project_start_receipt_template_idx" ON "module_project_start_receipt" USING btree ("template_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "module_project_template_key_unique" ON "module_project_template" USING btree ("template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "module_project_template_module_version_unique" ON "module_project_template" USING btree ("course_version_id","module_key","template_version");--> statement-breakpoint
CREATE INDEX "module_project_template_catalog_idx" ON "module_project_template" USING btree ("course_version_id","stage","module_key");--> statement-breakpoint
CREATE UNIQUE INDEX "module_project_template_event_request_unique" ON "module_project_template_event" USING btree ("template_id","request_id");--> statement-breakpoint
CREATE INDEX "module_project_template_event_timeline_idx" ON "module_project_template_event" USING btree ("template_id","occurred_at","id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_assignment_template_id_module_project_template_id_fk" FOREIGN KEY ("assignment_template_id") REFERENCES "public"."module_project_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_user_assignment_unique" ON "project" USING btree ("user_id","assignment_template_id") WHERE "project"."assignment_template_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_assignment_template_idx" ON "project" USING btree ("assignment_template_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_assignment_shape" CHECK (("project"."assignment_template_id" IS NULL AND "project"."assignment_content_hash" IS NULL AND "project"."assignment_stage_at_start" IS NULL AND "project"."assignment_provenance" IS NULL)
        OR ("project"."assignment_template_id" IS NOT NULL AND "project"."assignment_content_hash" ~ '^[0-9a-f]{64}$' AND "project"."assignment_stage_at_start" IN ('beta','verified') AND jsonb_typeof("project"."assignment_provenance") = 'object'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_module_project_template()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_row record;
  reviewer_ok boolean;
BEGIN
  SELECT cv.id, cv.version, cv.stage, cv.content_hash, c.id AS course_id, c.slug
    INTO version_row
    FROM course_version cv
    JOIN course c ON c.id = cv.course_id
   WHERE cv.id = NEW.course_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'module project course version not found'; END IF;

  IF NEW.source_course_content_hash IS DISTINCT FROM version_row.content_hash
    OR NEW.brief->>'templateKey' IS DISTINCT FROM NEW.template_key
    OR NEW.brief->>'templateVersion' IS DISTINCT FROM NEW.template_version
    OR NEW.brief->>'contentHash' IS DISTINCT FROM NEW.content_hash
    OR NEW.brief->>'courseId' IS DISTINCT FROM version_row.slug
    OR NEW.brief->>'courseVersion' IS DISTINCT FROM version_row.version
    OR NEW.brief->>'moduleId' IS DISTINCT FROM NEW.module_key
    OR NEW.brief->>'directAwardPolicy' IS DISTINCT FROM 'none'
    OR NEW.brief->'solution' IS DISTINCT FROM 'null'::jsonb
    OR jsonb_typeof(NEW.brief->'milestones') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.brief->'milestones') < 4
    OR jsonb_typeof(NEW.brief->'acceptanceChecks') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.brief->'acceptanceChecks') <> 3
    OR jsonb_typeof(NEW.brief->'prerequisiteSkillIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.brief->'prerequisiteSkillIds') < 1
  THEN
    RAISE EXCEPTION 'module project template provenance or solution-free contract mismatch';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.stage <> 'draft' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'module project templates must begin as revision-one drafts';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
    OR NEW.module_key IS DISTINCT FROM OLD.module_key
    OR NEW.template_key IS DISTINCT FROM OLD.template_key
    OR NEW.template_version IS DISTINCT FROM OLD.template_version
    OR NEW.source_course_content_hash IS DISTINCT FROM OLD.source_course_content_hash
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.brief IS DISTINCT FROM OLD.brief
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'module project template content and identity are immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'module project template revision must advance exactly once';
  END IF;
  IF NOT (
    (OLD.stage = 'draft' AND NEW.stage = 'beta')
    OR (OLD.stage = 'beta' AND NEW.stage = 'verified')
    OR (OLD.stage IN ('draft','beta','verified') AND NEW.stage = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid module project publication transition';
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM "user" reviewer
     WHERE reviewer.id = NEW.reviewed_by_user_id
       AND reviewer.role = 'admin' AND reviewer.status = 'active'
  ) INTO reviewer_ok;
  IF NOT reviewer_ok THEN RAISE EXCEPTION 'active administrator review required'; END IF;

  IF NEW.stage IN ('beta','verified') THEN
    IF NOT EXISTS (
      SELECT 1
        FROM curriculum_publication_pointer pointer
       WHERE pointer.course_id = version_row.course_id
         AND pointer.current_course_version_id = NEW.course_version_id
    )
      OR version_row.content_hash IS DISTINCT FROM NEW.source_course_content_hash
      OR NOT EXISTS (SELECT 1 FROM curriculum_release_evidence evidence WHERE evidence.course_version_id = NEW.course_version_id)
      OR NOT EXISTS (SELECT 1 FROM curriculum_artifact artifact WHERE artifact.course_version_id = NEW.course_version_id)
      OR EXISTS (SELECT 1 FROM curriculum_artifact artifact WHERE artifact.course_version_id = NEW.course_version_id AND artifact.review_status <> 'approved')
      OR (NEW.stage = 'beta' AND version_row.stage NOT IN ('beta','verified'))
      OR (NEW.stage = 'verified' AND version_row.stage <> 'verified')
    THEN
      RAISE EXCEPTION 'module project publication gate failed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER module_project_template_guard
BEFORE INSERT OR UPDATE ON module_project_template
FOR EACH ROW EXECUTE FUNCTION guard_module_project_template();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_module_project_template_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  template_row record;
  expected_event text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'module project review events are append-only'; END IF;
  SELECT * INTO template_row FROM module_project_template WHERE id = NEW.template_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'module project template not found'; END IF;
  expected_event := CASE template_row.stage
    WHEN 'beta' THEN 'reviewed_beta'
    WHEN 'verified' THEN 'promoted_verified'
    WHEN 'retired' THEN 'retired'
    ELSE NULL
  END;
  IF expected_event IS NULL
    OR NEW.event IS DISTINCT FROM expected_event
    OR NEW.actor_user_id IS DISTINCT FROM template_row.reviewed_by_user_id
    OR NEW.resulting_version IS DISTINCT FROM template_row.row_version
    OR NEW.evidence->>'templateId' IS DISTINCT FROM template_row.id::text
    OR NEW.evidence->>'templateKey' IS DISTINCT FROM template_row.template_key
    OR NEW.evidence->>'templateContentHash' IS DISTINCT FROM template_row.content_hash
    OR NEW.evidence->>'courseVersionId' IS DISTINCT FROM template_row.course_version_id::text
    OR NEW.evidence->>'resultingStage' IS DISTINCT FROM template_row.stage::text
    OR NEW.evidence->>'resultingVersion' IS DISTINCT FROM template_row.row_version::text
    OR NEW.evidence->>'directAwardPolicy' IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'module project review event does not match the committed transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER module_project_template_event_guard
BEFORE INSERT OR UPDATE OR DELETE ON module_project_template_event
FOR EACH ROW EXECUTE FUNCTION guard_module_project_template_event();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_module_project_transition_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE expected_event text;
BEGIN
  expected_event := CASE NEW.stage
    WHEN 'beta' THEN 'reviewed_beta'
    WHEN 'verified' THEN 'promoted_verified'
    WHEN 'retired' THEN 'retired'
    ELSE NULL
  END;
  IF expected_event IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM module_project_template_event event
     WHERE event.template_id = NEW.id
       AND event.actor_user_id = NEW.reviewed_by_user_id
       AND event.event = expected_event
       AND event.resulting_version = NEW.row_version
  ) THEN
    RAISE EXCEPTION 'module project publication transition lacks append-only review evidence';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER module_project_template_event_required
AFTER UPDATE OF stage ON module_project_template
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_module_project_transition_event();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_module_project_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  template_row record;
  enrollment_row record;
  latest_plan jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.assignment_template_id IS NOT NULL AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.assignment_template_id IS DISTINCT FROM OLD.assignment_template_id
    OR NEW.assignment_content_hash IS DISTINCT FROM OLD.assignment_content_hash
    OR NEW.assignment_stage_at_start IS DISTINCT FROM OLD.assignment_stage_at_start
    OR NEW.assignment_provenance IS DISTINCT FROM OLD.assignment_provenance
    OR NEW.prd IS DISTINCT FROM OLD.prd
  ) THEN
    RAISE EXCEPTION 'module project assignment identity, brief, and provenance are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.assignment_template_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.assignment_template_id IS NULL THEN RETURN NEW; END IF;

  SELECT template.*, cv.version AS course_version, cv.stage AS course_stage,
         cv.content_hash AS course_content_hash, c.id AS course_id, c.slug AS course_slug
    INTO template_row
    FROM module_project_template template
    JOIN course_version cv ON cv.id = template.course_version_id
    JOIN course c ON c.id = cv.course_id
   WHERE template.id = NEW.assignment_template_id;
  IF NOT FOUND OR template_row.stage NOT IN ('beta','verified')
    OR template_row.course_stage NOT IN ('beta','verified')
    OR template_row.source_course_content_hash IS DISTINCT FROM template_row.course_content_hash
    OR NEW.assignment_content_hash IS DISTINCT FROM template_row.content_hash
    OR NEW.assignment_stage_at_start IS DISTINCT FROM template_row.stage::text
    OR NEW.assignment_provenance->>'policyVersion' IS DISTINCT FROM 'module-project-start-2026-07-14.v1'
    OR NEW.assignment_provenance->>'templateId' IS DISTINCT FROM template_row.id::text
    OR NEW.assignment_provenance->>'templateKey' IS DISTINCT FROM template_row.template_key
    OR NEW.assignment_provenance->>'templateVersion' IS DISTINCT FROM template_row.template_version
    OR NEW.assignment_provenance->>'templateContentHash' IS DISTINCT FROM template_row.content_hash
    OR NEW.assignment_provenance->>'templateStage' IS DISTINCT FROM template_row.stage::text
    OR NEW.assignment_provenance->>'courseVersionId' IS DISTINCT FROM template_row.course_version_id::text
    OR NEW.assignment_provenance->>'courseVersion' IS DISTINCT FROM template_row.course_version
    OR NEW.assignment_provenance->>'courseContentHash' IS DISTINCT FROM template_row.source_course_content_hash
    OR NEW.assignment_provenance->>'courseId' IS DISTINCT FROM template_row.course_slug
    OR NEW.assignment_provenance->>'moduleId' IS DISTINCT FROM template_row.module_key
    OR NEW.assignment_provenance->>'directAwardPolicy' IS DISTINCT FROM 'none'
    OR NEW.prd->>'version' IS DISTINCT FROM 'module-project-1.0'
  THEN
    RAISE EXCEPTION 'module project assignment provenance mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "user" learner
     WHERE learner.id = NEW.user_id AND learner.role = 'learner' AND learner.status = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM curriculum_publication_pointer pointer
     WHERE pointer.course_id = template_row.course_id
       AND pointer.current_course_version_id = template_row.course_version_id
  ) THEN
    RAISE EXCEPTION 'module project learner or current-publication gate failed';
  END IF;

  SELECT enrollment.* INTO enrollment_row
    FROM enrollment
   WHERE enrollment.user_id = NEW.user_id
     AND enrollment.course_version_id = template_row.course_version_id
     AND enrollment.status IN ('active','completed')
   ORDER BY enrollment.created_at DESC, enrollment.id DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'module project active enrollment required'; END IF;
  SELECT revision.plan INTO latest_plan
    FROM plan_revision revision
   WHERE revision.enrollment_id = enrollment_row.id
   ORDER BY revision.revision DESC LIMIT 1;
  IF latest_plan IS NULL OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(template_row.brief->'prerequisiteSkillIds') required(skill_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(latest_plan) planned(item)
        WHERE planned.item->>'trackId' = template_row.course_slug
          AND planned.item->>'courseVersion' = template_row.course_version
          AND planned.item->>'moduleId' = template_row.module_key
          AND planned.item->>'skillId' = required.skill_id
     )
  ) THEN
    RAISE EXCEPTION 'module project exact plan prerequisite gate failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM user_achievement owned
      JOIN achievement badge ON badge.id = owned.achievement_id
      JOIN attempt evidence_attempt
        ON owned.evidence_id = 'exam-attempt:' || evidence_attempt.id::text
       AND evidence_attempt.user_id = owned.user_id
       AND evidence_attempt.enrollment_id = enrollment_row.id
     WHERE owned.user_id = NEW.user_id AND owned.revoked_at IS NULL
       AND badge.rule_version = 'exam-mastery-v1'
       AND badge.rule->>'event' = 'exam_mastery'
       AND badge.rule->>'courseId' = template_row.course_slug
       AND badge.rule->>'moduleId' = template_row.module_key
       AND badge.rule->>'minimumScorePercent' = '95'
       AND badge.rule->>'criticalRequirementsRequired' = 'true'
       AND evidence_attempt.status = 'graded' AND evidence_attempt.passed = true
       AND round(evidence_attempt.score::numeric,4) >= 0.95
       AND evidence_attempt.mastery_awarded = true AND evidence_attempt.assistance_level = 'A0'
       AND evidence_attempt.solution_revealed = false
  ) THEN
    RAISE EXCEPTION 'module project independent mastery gate failed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER module_project_assignment_guard
BEFORE INSERT OR UPDATE ON project
FOR EACH ROW EXECUTE FUNCTION guard_module_project_assignment();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_module_project_start_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.account_deletion_authorized', true) = '1' THEN RETURN OLD; END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'module project start receipts are append-only'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project owned
     WHERE owned.id = NEW.project_id AND owned.user_id = NEW.user_id
       AND owned.assignment_template_id = NEW.template_id
       AND owned.assignment_content_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'module project start receipt owner, template, or project mismatch';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER module_project_start_receipt_guard
BEFORE INSERT OR UPDATE OR DELETE ON module_project_start_receipt
FOR EACH ROW EXECUTE FUNCTION guard_module_project_start_receipt();
