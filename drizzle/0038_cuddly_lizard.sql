ALTER TABLE "runner_job" ADD COLUMN "recovery_state" text;--> statement-breakpoint
ALTER TABLE "runner_job" ADD COLUMN "recovery_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_job" ADD COLUMN "recovery_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runner_job" ADD COLUMN "recovery_last_error_code" text;--> statement-breakpoint
UPDATE "runner_job" AS j
   SET "recovery_state" = 'ready'
  FROM "code_submission" AS s
 WHERE s."id" = j."submission_id"
   AND s."submission_type" IN ('server_compile', 'server_run')
   AND s."status" IN ('queued', 'leased', 'running')
   AND j."status" IN ('queued', 'leased', 'running')
   AND j."dispatch_request" IS NOT NULL
   AND j."recovery_state" IS NULL;--> statement-breakpoint
UPDATE "runner_job" AS j
   SET "recovery_state" = 'quarantined',
       "recovery_attempt_count" = 1,
       "recovery_next_attempt_at" = NULL,
       "recovery_last_error_code" = 'PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING'
  FROM "code_submission" AS s
 WHERE s."id" = j."submission_id"
   AND s."submission_type" IN ('server_compile', 'server_run')
   AND (s."status" IN ('queued', 'leased', 'running') OR j."status" IN ('queued', 'leased', 'running'))
   AND (s."status" IN ('leased', 'running') OR j."status" IN ('leased', 'running'))
   AND j."dispatch_request" IS NULL
   AND j."recovery_state" IS NULL;--> statement-breakpoint
ALTER TABLE "runner_job" ADD CONSTRAINT "runner_job_recovery_state_check" CHECK ("runner_job"."recovery_state" is null or "runner_job"."recovery_state" in ('ready','retry_wait','quarantined'));--> statement-breakpoint
ALTER TABLE "runner_job" ADD CONSTRAINT "runner_job_recovery_attempt_check" CHECK ("runner_job"."recovery_attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "runner_job" ADD CONSTRAINT "runner_job_recovery_snapshot_check" CHECK ("runner_job"."recovery_state" is null or "runner_job"."dispatch_request" is not null or ("runner_job"."recovery_state" = 'quarantined' and "runner_job"."recovery_last_error_code" = 'PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING'));
