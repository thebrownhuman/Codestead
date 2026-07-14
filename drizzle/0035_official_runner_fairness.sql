ALTER TABLE "code_submission" ADD COLUMN "request_id" text DEFAULT 'legacy-' || gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "code_submission" ADD COLUMN "request_hash" text DEFAULT repeat('0', 64) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "code_submission_user_request_unique" ON "code_submission" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "code_submission_one_active_official_user" ON "code_submission" USING btree ("user_id") WHERE "code_submission"."submission_type" IN ('exam_final_test', 'assessment_correction_regrade')
        AND "code_submission"."status" IN ('queued', 'leased', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "runner_job_submission_unique" ON "runner_job" USING btree ("submission_id");--> statement-breakpoint
ALTER TABLE "code_submission" ADD CONSTRAINT "code_submission_request_id_shape" CHECK (char_length("code_submission"."request_id") BETWEEN 8 AND 128 AND "code_submission"."request_id" ~ '^[A-Za-z0-9._:-]+$');--> statement-breakpoint
ALTER TABLE "code_submission" ADD CONSTRAINT "code_submission_request_hash_shape" CHECK ("code_submission"."request_hash" ~ '^[0-9a-f]{64}$');