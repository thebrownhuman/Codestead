CREATE OR REPLACE FUNCTION "protect_project_review_evidence"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."commit_sha" IS DISTINCT FROM OLD."commit_sha"
    OR NEW."analyzer_version" IS DISTINCT FROM OLD."analyzer_version"
    OR NEW."rubric_version" IS DISTINCT FROM OLD."rubric_version"
    OR NEW."model_call_id" IS DISTINCT FROM OLD."model_call_id"
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
CREATE OR REPLACE FUNCTION "protect_project_review_correction_evidence"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."source_review_id" IS DISTINCT FROM OLD."source_review_id"
    OR NEW."source_appeal_id" IS DISTINCT FROM OLD."source_appeal_id"
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
$function$;
