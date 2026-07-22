ALTER TYPE "public"."notification_status" RENAME TO "notification_status_old";--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'suppressed', 'quarantined');--> statement-breakpoint
DO $migration$
DECLARE
  old_owner oid;
  acl record;
  grantee_sql text;
  grantee_name text;
BEGIN
  SELECT t.typowner
    INTO STRICT old_owner
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public'
     AND t.typname = 'notification_status_old';

  IF old_owner <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'notification_status enum owner does not match migration role';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) grants
     WHERE n.nspname = 'public'
       AND t.typname = 'notification_status_old'
       AND grants.grantee <> t.typowner
       AND grants.grantor <> t.typowner
  ) THEN
    RAISE EXCEPTION 'notification_status has a delegated ACL grantor';
  END IF;

  FOR acl IN
    SELECT grants.grantee
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) grants
     WHERE n.nspname = 'public'
       AND t.typname = 'notification_status'
       AND grants.grantee <> t.typowner
  LOOP
    IF acl.grantee = 0 THEN
      grantee_sql := 'PUBLIC';
    ELSE
      SELECT r.rolname
        INTO grantee_name
        FROM pg_roles r
       WHERE r.oid = acl.grantee;
      IF grantee_name IS NULL THEN
        RAISE EXCEPTION 'notification_status ACL references unresolved role OID %', acl.grantee;
      END IF;
      grantee_sql := quote_ident(grantee_name);
    END IF;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TYPE public.notification_status FROM %s',
      grantee_sql
    );
  END LOOP;

  FOR acl IN
    SELECT grants.grantee, grants.is_grantable
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) grants
     WHERE n.nspname = 'public'
       AND t.typname = 'notification_status_old'
       AND grants.privilege_type = 'USAGE'
       AND grants.grantee <> t.typowner
  LOOP
    IF acl.grantee = 0 THEN
      grantee_sql := 'PUBLIC';
    ELSE
      SELECT r.rolname
        INTO grantee_name
        FROM pg_roles r
       WHERE r.oid = acl.grantee;
      IF grantee_name IS NULL THEN
        RAISE EXCEPTION 'notification_status ACL references unresolved role OID %', acl.grantee;
      END IF;
      grantee_sql := quote_ident(grantee_name);
    END IF;
    EXECUTE format(
      'GRANT USAGE ON TYPE public.notification_status TO %s%s',
      grantee_sql,
      CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    );
  END LOOP;
END
$migration$;--> statement-breakpoint
ALTER TABLE "email_outbox" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "email_outbox" ALTER COLUMN "status" TYPE "public"."notification_status" USING "status"::text::"public"."notification_status";--> statement-breakpoint
ALTER TABLE "email_outbox" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."notification_status_old";--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "operation_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "claim_owner" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "claim_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider_call_started" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "adapter" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
UPDATE "email_outbox"
   SET "status" = 'quarantined',
       "last_error_code" = 'LEGACY_SENDING_AMBIGUOUS',
       "quarantined_at" = COALESCE("quarantined_at", now()),
       "claim_token" = NULL,
       "claim_owner" = NULL,
       "lease_expires_at" = NULL,
       "updated_at" = now()
 WHERE "status" = 'sending';--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_claim_token_unique" ON "email_outbox" USING btree ("claim_token") WHERE "email_outbox"."claim_token" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_provider_message_unique" ON "email_outbox" USING btree ("adapter","provider_message_id") WHERE "email_outbox"."provider_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_operation_id_unique" UNIQUE("operation_id");--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_claim_version_nonnegative" CHECK ("email_outbox"."claim_version" >= 0);--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_provider_identity_valid" CHECK ("email_outbox"."provider_message_id" IS NULL OR ("email_outbox"."adapter" IS NOT NULL AND btrim("email_outbox"."adapter") <> '' AND btrim("email_outbox"."provider_message_id") <> ''));--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_quarantine_evidence" CHECK ("email_outbox"."status" <> 'quarantined' OR ("email_outbox"."quarantined_at" IS NOT NULL AND "email_outbox"."last_error_code" IS NOT NULL AND btrim("email_outbox"."last_error_code") <> ''));