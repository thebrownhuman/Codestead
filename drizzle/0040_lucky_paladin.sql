ALTER TABLE "runner_job" DROP CONSTRAINT "runner_job_recovery_snapshot_check";--> statement-breakpoint
UPDATE "runner_job" AS j
   SET "recovery_state" = 'quarantined',
       "recovery_attempt_count" = greatest(j."recovery_attempt_count", 1),
       "recovery_next_attempt_at" = NULL,
       "recovery_last_error_code" = 'PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING'
  FROM "code_submission" AS s
 WHERE s."id" = j."submission_id"
   AND s."submission_type" IN ('server_compile', 'server_run')
   AND (s."status" IN ('queued', 'leased', 'running') OR j."status" IN ('queued', 'leased', 'running'))
   AND (s."status" IN ('leased', 'running') OR j."status" IN ('leased', 'running'))
   AND j."dispatch_request" IS NULL
   AND j."recovery_state" IS NULL;--> statement-breakpoint
ALTER TABLE "runner_job" ADD CONSTRAINT "runner_job_recovery_snapshot_check" CHECK ("runner_job"."recovery_state" is null or "runner_job"."dispatch_request" is not null or (
        "runner_job"."recovery_state" = 'quarantined'
        and "runner_job"."recovery_last_error_code" = 'PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING'
      ));
