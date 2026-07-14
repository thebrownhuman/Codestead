ALTER TABLE "runner_job" ADD COLUMN "dispatch_request" jsonb;--> statement-breakpoint
ALTER TABLE "runner_job" ADD CONSTRAINT "runner_job_dispatch_request_shape" CHECK ("runner_job"."dispatch_request" is null or (jsonb_typeof("runner_job"."dispatch_request") = 'object' and octet_length("runner_job"."dispatch_request"::text) <= 1048576));--> statement-breakpoint
CREATE FUNCTION "protect_runner_dispatch_request"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.dispatch_request IS NOT NULL
     AND NEW.dispatch_request IS DISTINCT FROM OLD.dispatch_request THEN
    RAISE EXCEPTION 'runner dispatch request is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'runner_job_dispatch_request_immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "runner_job_dispatch_request_immutable_trigger"
BEFORE UPDATE ON "runner_job"
FOR EACH ROW EXECUTE FUNCTION "protect_runner_dispatch_request"();
