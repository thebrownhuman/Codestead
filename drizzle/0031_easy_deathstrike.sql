ALTER TABLE "project_review_correction_event" DROP CONSTRAINT "project_review_correction_event_type";--> statement-breakpoint
ALTER TABLE "project_review_correction" DROP CONSTRAINT "project_review_correction_source_appeal_id_appeal_id_fk";
--> statement-breakpoint
ALTER TABLE "project_review_effective" DROP CONSTRAINT "project_review_effective_correction_id_project_review_correction_id_fk";
--> statement-breakpoint
ALTER TABLE "project_review_correction" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_review_correction" ADD CONSTRAINT "project_review_correction_source_appeal_id_appeal_id_fk" FOREIGN KEY ("source_appeal_id") REFERENCES "public"."appeal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_effective" ADD CONSTRAINT "project_review_effective_correction_id_project_review_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."project_review_correction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review_correction_event" ADD CONSTRAINT "project_review_correction_event_type" CHECK ("project_review_correction_event"."event" IN ('queued', 'retry_queued', 'analysis_started', 'analysis_succeeded', 'analysis_failed', 'projection_applied', 'projection_skipped'));--> statement-breakpoint
CREATE FUNCTION "require_account_deletion_for_project_review_evidence"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.account_deletion_authorized', true) IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION 'project review evidence may only be deleted by the authorized account-deletion transaction'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "project_review_delete_guard_trigger"
BEFORE DELETE ON "project_review"
FOR EACH ROW EXECUTE FUNCTION "require_account_deletion_for_project_review_evidence"();--> statement-breakpoint
CREATE TRIGGER "project_review_correction_delete_guard_trigger"
BEFORE DELETE ON "project_review_correction"
FOR EACH ROW EXECUTE FUNCTION "require_account_deletion_for_project_review_evidence"();--> statement-breakpoint
CREATE TRIGGER "project_review_correction_event_delete_guard_trigger"
BEFORE DELETE ON "project_review_correction_event"
FOR EACH ROW EXECUTE FUNCTION "require_account_deletion_for_project_review_evidence"();--> statement-breakpoint
CREATE FUNCTION "protect_project_review_effective_projection"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.account_deletion_authorized', true) = '1'
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE'
    OR current_setting('app.project_review_projection_write', true) IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION 'project review effective projection requires the authoritative projection writer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "project_review_effective_projection_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "project_review_effective"
FOR EACH ROW EXECUTE FUNCTION "protect_project_review_effective_projection"();
