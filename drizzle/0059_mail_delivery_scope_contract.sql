LOCK TABLE "email_outbox" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "email_outbox"
   SET "delivery_scope_key" = 'a:' || "user_id"
 WHERE "delivery_scope_key" IS NULL
   AND "user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "email_outbox"
   SET "delivery_scope_key" = 's:' || "operation_id"::text
 WHERE "delivery_scope_key" IS NULL
   AND "user_id" IS NULL
   AND "template_version" = '1'
   AND "template" IN ('invitation', 'access-rejected');--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "email_outbox"
     WHERE "delivery_scope_key" IS NULL
       AND "status" = 'sending'
       AND "lease_expires_at" IS NOT NULL
       AND "lease_expires_at" > statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'email_outbox has an active unresolved delivery-scope lease'
      USING ERRCODE = '55006';
  END IF;
END
$migration$;--> statement-breakpoint
UPDATE "email_outbox"
   SET "delivery_scope_key" = 'o:' || "operation_id"::text,
       "to_email" = 'unresolved-recipient@invalid.local',
       "variables" = '{}'::jsonb,
       "status" = 'quarantined',
       "last_error_code" = CASE
         WHEN "provider_call_started" IS NOT NULL
           THEN 'UNRESOLVED_DELIVERY_SCOPE_PROVIDER_UNKNOWN'
         ELSE 'UNRESOLVED_DELIVERY_SCOPE'
       END,
       "quarantined_at" = COALESCE("quarantined_at", statement_timestamp()),
       "claim_token" = NULL,
       "claim_owner" = NULL,
       "claim_version" = CASE
         WHEN "claim_version" < 2147483647 THEN "claim_version" + 1
         ELSE "claim_version"
       END,
       "lease_expires_at" = NULL,
       "updated_at" = statement_timestamp()
 WHERE "delivery_scope_key" IS NULL
   AND "user_id" IS NULL
   AND "status" IN ('pending', 'sending');--> statement-breakpoint
UPDATE "email_outbox"
   SET "delivery_scope_key" = 'o:' || "operation_id"::text,
       "to_email" = 'unresolved-recipient@invalid.local',
       "variables" = '{}'::jsonb
 WHERE "delivery_scope_key" IS NULL
   AND "user_id" IS NULL
   AND "status" IN ('sent', 'failed', 'suppressed', 'quarantined');--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "email_outbox"
     WHERE "delivery_scope_key" IS NULL
  ) THEN
    RAISE EXCEPTION 'email_outbox delivery-scope catch-up left an unclassified row'
      USING ERRCODE = '23514';
  END IF;
END
$migration$;--> statement-breakpoint
ALTER TABLE "email_outbox"
  DROP CONSTRAINT "email_outbox_delivery_scope_valid";--> statement-breakpoint
ALTER TABLE "email_outbox"
  ADD CONSTRAINT "email_outbox_delivery_scope_valid" CHECK (
    ("email_outbox"."user_id" IS NOT NULL
      AND "email_outbox"."delivery_scope_key" = 'a:' || "email_outbox"."user_id")
    OR ("email_outbox"."user_id" IS NULL
      AND "email_outbox"."delivery_scope_key" = 's:' || "email_outbox"."operation_id"::text
      AND "email_outbox"."template_version" = '1'
      AND "email_outbox"."template" IN ('invitation', 'access-rejected'))
    OR ("email_outbox"."user_id" IS NULL
      AND "email_outbox"."delivery_scope_key" = 'o:' || "email_outbox"."operation_id"::text
      AND "email_outbox"."status" IN ('sent', 'failed', 'suppressed', 'quarantined'))
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE "email_outbox"
  VALIDATE CONSTRAINT "email_outbox_delivery_scope_valid";--> statement-breakpoint
ALTER TABLE "email_outbox"
  ALTER COLUMN "delivery_scope_key" SET NOT NULL;
