CREATE FUNCTION "protect_appeal_immutable_fields"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."attempt_id" IS DISTINCT FROM OLD."attempt_id"
    OR NEW."project_review_id" IS DISTINCT FROM OLD."project_review_id"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."submission_request_id" IS DISTINCT FROM OLD."submission_request_id"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."evidence" IS DISTINCT FROM OLD."evidence"
    OR NEW."evidence_hash" IS DISTINCT FROM OLD."evidence_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'appeal target, claim, and evidence are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "appeal_immutable_fields_trigger"
BEFORE UPDATE ON "appeal"
FOR EACH ROW EXECUTE FUNCTION "protect_appeal_immutable_fields"();--> statement-breakpoint
CREATE FUNCTION "protect_appeal_event_update"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'appeal events are append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "appeal_event_append_only_trigger"
BEFORE UPDATE ON "appeal_event"
FOR EACH ROW EXECUTE FUNCTION "protect_appeal_event_update"();
