ALTER TABLE "reward_reconciliation_job" DROP CONSTRAINT "reward_reconciliation_job_status_check";--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "daily_study_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "revision_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "goal_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "challenge_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "weekly_summary_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "notification_preference" ALTER COLUMN "learning_email_enabled" SET DEFAULT false;--> statement-breakpoint
-- These switches previously defaulted on, so an existing true value cannot be
-- distinguished from affirmative learner choice. Reset the beta-era values;
-- every learner can opt in again through the explicit preferences form.
UPDATE "notification_preference"
   SET "daily_study_enabled" = false,
       "revision_enabled" = false,
       "goal_enabled" = false,
       "challenge_enabled" = false,
       "weekly_summary_enabled" = false,
       "learning_email_enabled" = false,
       "row_version" = "row_version" + 1,
       "updated_at" = now();--> statement-breakpoint
-- A report owned by a deleted learner is erased, while its moderation event
-- remains as non-private provenance. Permit only the FK's report-id unlink in
-- the already-authorized account-deletion transaction; every other update and
-- every normal-operation delete remains blocked.
CREATE OR REPLACE FUNCTION "community_battle_append_only_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.account_deletion_authorized', true) = '1' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'community_moderation_event' THEN
    IF TG_OP = 'UPDATE'
       AND current_setting('app.account_deletion_authorized', true) = '1'
       AND OLD.report_id IS NOT NULL
       AND NEW.report_id IS NULL
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
       AND NEW.post_id IS NOT DISTINCT FROM OLD.post_id
       AND NEW.reply_id IS NOT DISTINCT FROM OLD.reply_id
       AND NEW.action IS NOT DISTINCT FROM OLD.action
       AND NEW.prior_state IS NOT DISTINCT FROM OLD.prior_state
       AND NEW.resulting_state IS NOT DISTINCT FROM OLD.resulting_state
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason
       AND NEW.occurred_at IS NOT DISTINCT FROM OLD.occurred_at THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
ALTER TABLE "reward_reconciliation_job" ADD CONSTRAINT "reward_reconciliation_job_status_check" CHECK ("reward_reconciliation_job"."status" IN ('pending', 'running', 'complete', 'dead_letter'));
