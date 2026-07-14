ALTER TABLE "admin_fallback_grant" DROP CONSTRAINT "admin_fallback_grant_learner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" DROP CONSTRAINT "admin_fallback_grant_credential_id_provider_credential_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_fallback_reservation" DROP CONSTRAINT "admin_fallback_reservation_grant_id_admin_fallback_grant_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_fallback_reservation" DROP CONSTRAINT "admin_fallback_reservation_learner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "provider" "ai_provider";--> statement-breakpoint
UPDATE "admin_fallback_grant" AS afg
SET "provider" = credential."provider"
FROM "provider_credential" AS credential
WHERE credential."id" = afg."credential_id";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "admin_fallback_grant" WHERE "provider" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill fallback grant provider snapshot';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ALTER COLUMN "provider" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "create_request_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "create_request_hash" text DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "revoke_request_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "revoke_request_hash" text;--> statement-breakpoint
ALTER TABLE "provider_operation_receipt" ADD COLUMN "lease_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_operation_receipt" ADD COLUMN "lease_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_operation_receipt" ADD COLUMN "lease_expires_at" timestamp with time zone DEFAULT now() + interval '5 minutes' NOT NULL;--> statement-breakpoint
UPDATE "admin_fallback_grant"
SET
	"status" = 'revoked',
	"revoked_by" = "granted_by",
	"revoke_request_id" = gen_random_uuid(),
	"revoke_request_hash" = "create_request_hash"
WHERE "revoked_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "admin_fallback_grant_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "admin_fallback_grant_learner_id_user_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "admin_fallback_grant_credential_id_provider_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_reservation" ADD CONSTRAINT "admin_fallback_reservation_grant_id_admin_fallback_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."admin_fallback_grant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_reservation" ADD CONSTRAINT "admin_fallback_reservation_learner_id_user_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fallback_grant_active_destination_idx" ON "admin_fallback_grant" USING btree ("learner_id","provider","model","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fallback_grant_create_request_unique" ON "admin_fallback_grant" USING btree ("granted_by","create_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fallback_grant_revoke_request_unique" ON "admin_fallback_grant" USING btree ("revoked_by","revoke_request_id") WHERE "admin_fallback_grant"."revoke_request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_status_check" CHECK ("admin_fallback_grant"."status" IN ('active', 'revoked'));--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_create_hash_check" CHECK ("admin_fallback_grant"."create_request_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_revoke_hash_check" CHECK ("admin_fallback_grant"."revoke_request_hash" IS NULL OR "admin_fallback_grant"."revoke_request_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_state_check" CHECK (("admin_fallback_grant"."status" = 'active' AND "admin_fallback_grant"."revoked_at" IS NULL AND "admin_fallback_grant"."revoked_by" IS NULL AND "admin_fallback_grant"."revoke_request_id" IS NULL AND "admin_fallback_grant"."revoke_request_hash" IS NULL)
        OR ("admin_fallback_grant"."status" = 'revoked' AND "admin_fallback_grant"."revoked_at" IS NOT NULL AND "admin_fallback_grant"."revoked_by" IS NOT NULL AND "admin_fallback_grant"."revoke_request_id" IS NOT NULL AND "admin_fallback_grant"."revoke_request_hash" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "provider_operation_receipt" ADD CONSTRAINT "provider_operation_receipt_lease_version_check" CHECK ("provider_operation_receipt"."lease_version" >= 1);--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_admin_fallback_grant_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."learner_id" IS DISTINCT FROM OLD."learner_id"
    OR NEW."credential_id" IS DISTINCT FROM OLD."credential_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."model" IS DISTINCT FROM OLD."model"
    OR NEW."token_budget" IS DISTINCT FROM OLD."token_budget"
    OR NEW."rupee_budget_paise" IS DISTINCT FROM OLD."rupee_budget_paise"
    OR NEW."input_paise_per_million_tokens" IS DISTINCT FROM OLD."input_paise_per_million_tokens"
    OR NEW."output_paise_per_million_tokens" IS DISTINCT FROM OLD."output_paise_per_million_tokens"
    OR NEW."starts_at" IS DISTINCT FROM OLD."starts_at"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."granted_by" IS DISTINCT FROM OLD."granted_by"
    OR NEW."create_request_id" IS DISTINCT FROM OLD."create_request_id"
    OR NEW."create_request_hash" IS DISTINCT FROM OLD."create_request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'Fallback grant authority fields are immutable';
  END IF;

  IF OLD."status" = 'revoked' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
    OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by"
    OR NEW."revoke_request_id" IS DISTINCT FROM OLD."revoke_request_id"
    OR NEW."revoke_request_hash" IS DISTINCT FROM OLD."revoke_request_hash"
  ) THEN
    RAISE EXCEPTION 'Fallback grant revocation is immutable';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'revoked') THEN
    RAISE EXCEPTION 'Invalid fallback grant status transition';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_fallback_grant_update_guard
BEFORE UPDATE ON "admin_fallback_grant"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_fallback_grant_update();--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_admin_fallback_reservation_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.account_deletion_authorized', true) = '1' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Fallback reservations cannot be deleted';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."grant_id" IS DISTINCT FROM OLD."grant_id"
    OR NEW."learner_id" IS DISTINCT FROM OLD."learner_id"
    OR NEW."reserved_tokens" IS DISTINCT FROM OLD."reserved_tokens"
    OR NEW."reserved_paise" IS DISTINCT FROM OLD."reserved_paise"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'Fallback reservation authority is immutable';
  END IF;
  IF OLD."status" = 'reconciled' THEN
    RAISE EXCEPTION 'Completed fallback reservations are immutable';
  END IF;
  IF NEW."status" <> 'reconciled' THEN
    RAISE EXCEPTION 'Fallback reservations may only transition to reconciled';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_fallback_reservation_update_guard
BEFORE UPDATE ON "admin_fallback_reservation"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_fallback_reservation_immutability();--> statement-breakpoint
CREATE TRIGGER admin_fallback_reservation_delete_guard
BEFORE DELETE ON "admin_fallback_reservation"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_fallback_reservation_immutability();
