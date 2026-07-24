DROP TRIGGER "email_outbox_delivery_scope_immutable" ON "email_outbox";--> statement-breakpoint
DROP FUNCTION "public"."enforce_email_outbox_delivery_scope_immutable"();--> statement-breakpoint
CREATE FUNCTION "public"."enforce_email_outbox_payload_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'email_outbox.user_id is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.to_email IS DISTINCT FROM NEW.to_email THEN
    RAISE EXCEPTION 'email_outbox.to_email is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.template IS DISTINCT FROM NEW.template THEN
    RAISE EXCEPTION 'email_outbox.template is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.template_version IS DISTINCT FROM NEW.template_version THEN
    RAISE EXCEPTION 'email_outbox.template_version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.variables IS DISTINCT FROM NEW.variables THEN
    RAISE EXCEPTION 'email_outbox.variables is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'email_outbox.idempotency_key is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'email_outbox.operation_id is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.delivery_scope_key IS DISTINCT FROM NEW.delivery_scope_key THEN
    RAISE EXCEPTION 'email_outbox.delivery_scope_key is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "email_outbox_payload_immutable"
BEFORE UPDATE OF
  "user_id",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "operation_id",
  "delivery_scope_key"
ON "email_outbox"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_email_outbox_payload_immutable"();
