ALTER TABLE "email_outbox" ADD COLUMN "delivery_scope_key" text;--> statement-breakpoint
UPDATE "email_outbox"
   SET "delivery_scope_key" = 'a:' || "user_id"
 WHERE "user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "email_outbox"
   SET "delivery_scope_key" = 's:' || "operation_id"::text
 WHERE "user_id" IS NULL
   AND "template_version" = '1'
   AND "template" IN ('invitation', 'access-rejected');--> statement-breakpoint
UPDATE "email_outbox"
   SET "delivery_scope_key" = 'o:' || "operation_id"::text,
       "to_email" = 'unresolved-recipient@invalid.local',
       "variables" = '{}'::jsonb
 WHERE "delivery_scope_key" IS NULL
   AND NOT ("status" = 'sending' AND "lease_expires_at" IS NOT NULL
     AND "lease_expires_at" > now());--> statement-breakpoint
UPDATE "email_outbox"
   SET "status" = 'quarantined',
       "last_error_code" = 'UNRESOLVED_DELIVERY_SCOPE_PROVIDER_UNKNOWN',
       "quarantined_at" = COALESCE("quarantined_at", now()),
       "claim_token" = NULL,
       "claim_owner" = NULL,
       "claim_version" = "claim_version" + 1,
       "lease_expires_at" = NULL,
       "updated_at" = now()
 WHERE "delivery_scope_key" = 'o:' || "operation_id"::text
   AND "status" IN ('pending', 'sending')
   AND "provider_call_started" IS NOT NULL;--> statement-breakpoint
UPDATE "email_outbox"
   SET "status" = 'quarantined',
       "last_error_code" = 'UNRESOLVED_DELIVERY_SCOPE',
       "quarantined_at" = COALESCE("quarantined_at", now()),
       "claim_token" = NULL,
       "claim_owner" = NULL,
       "claim_version" = "claim_version" + 1,
       "lease_expires_at" = NULL,
       "updated_at" = now()
 WHERE "delivery_scope_key" = 'o:' || "operation_id"::text
   AND "status" IN ('pending', 'sending')
   AND "provider_call_started" IS NULL;--> statement-breakpoint
CREATE INDEX "email_outbox_delivery_scope_idx" ON "email_outbox" USING btree ("delivery_scope_key");--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_delivery_scope_valid" CHECK ("email_outbox"."delivery_scope_key" IS NULL OR (
        ("email_outbox"."user_id" IS NOT NULL AND "email_outbox"."delivery_scope_key" = 'a:' || "email_outbox"."user_id")
        OR ("email_outbox"."user_id" IS NULL AND "email_outbox"."delivery_scope_key" = 's:' || "email_outbox"."operation_id"::text
          AND "email_outbox"."template_version" = '1' AND "email_outbox"."template" IN ('invitation', 'access-rejected'))
        OR ("email_outbox"."user_id" IS NULL AND "email_outbox"."delivery_scope_key" = 'o:' || "email_outbox"."operation_id"::text
          AND "email_outbox"."status" IN ('sent', 'failed', 'suppressed', 'quarantined'))
      ));--> statement-breakpoint
CREATE FUNCTION "public"."enforce_email_outbox_delivery_scope_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'email_outbox.operation_id is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.delivery_scope_key IS NOT NULL
     AND OLD.delivery_scope_key IS DISTINCT FROM NEW.delivery_scope_key THEN
    RAISE EXCEPTION 'email_outbox.delivery_scope_key is immutable once assigned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "email_outbox_delivery_scope_immutable"
BEFORE UPDATE OF "operation_id", "delivery_scope_key" ON "email_outbox"
FOR EACH ROW EXECUTE FUNCTION "public"."enforce_email_outbox_delivery_scope_immutable"();
