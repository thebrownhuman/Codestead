CREATE INDEX "activity_lesson_idx" ON "activity" USING btree ("lesson_id");--> statement-breakpoint
CREATE INDEX "activity_concept_idx" ON "activity" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "attempt_activity_idx" ON "attempt" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "attempt_enrollment_idx" ON "attempt" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "code_submission_attempt_idx" ON "code_submission" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "code_submission_activity_idx" ON "code_submission" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "code_submission_test_bundle_idx" ON "code_submission" USING btree ("test_bundle_id");--> statement-breakpoint
CREATE INDEX "email_outbox_user_idx" ON "email_outbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "enrollment_course_version_idx" ON "enrollment" USING btree ("course_version_id");--> statement-breakpoint
CREATE INDEX "model_call_credential_idx" ON "model_call" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "prerequisite_to_concept_idx" ON "prerequisite" USING btree ("to_concept_id");--> statement-breakpoint
CREATE INDEX "project_review_project_idx" ON "project_review" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "learning_session_event_session_idx" ON "learning_session_event" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "test_bundle_activity_idx" ON "test_bundle" USING btree ("activity_id");