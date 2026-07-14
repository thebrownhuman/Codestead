CREATE FUNCTION "protect_course_version_content"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."course_id" IS DISTINCT FROM OLD."course_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."scope_statement" IS DISTINCT FROM OLD."scope_statement"
    OR NEW."source_commit" IS DISTINCT FROM OLD."source_commit"
    OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'course version content identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "course_version_content_immutable_trigger"
BEFORE UPDATE ON "course_version"
FOR EACH ROW EXECUTE FUNCTION "protect_course_version_content"();--> statement-breakpoint
CREATE FUNCTION "protect_curriculum_artifact_content"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."course_version_id" IS DISTINCT FROM OLD."course_version_id"
    OR NEW."artifact_key" IS DISTINCT FROM OLD."artifact_key"
    OR NEW."artifact_type" IS DISTINCT FROM OLD."artifact_type"
    OR NEW."skill_key" IS DISTINCT FROM OLD."skill_key"
    OR NEW."source_path" IS DISTINCT FROM OLD."source_path"
    OR NEW."content" IS DISTINCT FROM OLD."content"
    OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
    OR NEW."publication_stage" IS DISTINCT FROM OLD."publication_stage"
    OR NEW."ai_assisted" IS DISTINCT FROM OLD."ai_assisted"
    OR NEW."provenance" IS DISTINCT FROM OLD."provenance"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'curriculum artifact content and provenance are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "curriculum_artifact_content_immutable_trigger"
BEFORE UPDATE ON "curriculum_artifact"
FOR EACH ROW EXECUTE FUNCTION "protect_curriculum_artifact_content"();--> statement-breakpoint
CREATE FUNCTION "reject_curriculum_append_only_update"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'curriculum evidence and publication events are append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "curriculum_review_event_append_only_trigger"
BEFORE UPDATE ON "curriculum_review_event"
FOR EACH ROW EXECUTE FUNCTION "reject_curriculum_append_only_update"();--> statement-breakpoint
CREATE TRIGGER "curriculum_release_evidence_append_only_trigger"
BEFORE UPDATE ON "curriculum_release_evidence"
FOR EACH ROW EXECUTE FUNCTION "reject_curriculum_append_only_update"();--> statement-breakpoint
CREATE TRIGGER "curriculum_publication_event_append_only_trigger"
BEFORE UPDATE ON "curriculum_publication_event"
FOR EACH ROW EXECUTE FUNCTION "reject_curriculum_append_only_update"();
