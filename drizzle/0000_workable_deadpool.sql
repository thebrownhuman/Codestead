CREATE TYPE "public"."attempt_kind" AS ENUM('practice', 'diagnostic', 'quiz', 'game', 'mastery_check', 'exam', 'retake', 'project');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('created', 'in_progress', 'submitted', 'grading', 'graded', 'cancelled', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('pending_validation', 'active', 'invalid', 'rate_limited', 'disabled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."enrollment_status" AS ENUM('planned', 'active', 'paused', 'completed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."exam_status" AS ENUM('scheduled', 'active', 'paused_by_system', 'submitted', 'expired', 'graded', 'under_review', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'leased', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."mastery_status" AS ENUM('unseen', 'learning', 'practicing', 'proficient', 'mastered', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('nvidia_nim', 'openrouter', 'google', 'openai', 'anthropic', 'deepseek', 'custom_openai_compatible');--> statement-breakpoint
CREATE TYPE "public"."publication_stage" AS ENUM('draft', 'beta', 'verified', 'retired', 'coming_soon');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'suspended', 'deletion_pending', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('private', 'cohort', 'public');--> statement-breakpoint
CREATE TABLE "access_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"reason" text,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"adult_confirmed_at" timestamp with time zone,
	"decided_by" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "achievement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"rule_version" text NOT NULL,
	"rule" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"concept_id" uuid,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"instructions" text NOT NULL,
	"specification" jsonb NOT NULL,
	"difficulty" text NOT NULL,
	"max_points" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_fallback_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"token_budget" bigint NOT NULL,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appeal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" uuid,
	"project_review_id" uuid,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decision" text,
	"decision_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"activity_id" uuid,
	"enrollment_id" uuid,
	"kind" "attempt_kind" NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" "attempt_status" DEFAULT 'created' NOT NULL,
	"policy_version" text NOT NULL,
	"content_version" text NOT NULL,
	"score" real,
	"passed" boolean,
	"mastery_awarded" boolean DEFAULT false,
	"infrastructure_failure" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"graded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"subject_user_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"reason" text,
	"outcome" text NOT NULL,
	"correlation_id" text NOT NULL,
	"ip_pseudonym" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"previous_hash" text,
	"event_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_job_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"model_call_id" uuid,
	"curriculum_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"safety_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"enrollment_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" uuid,
	"activity_id" uuid,
	"language" text NOT NULL,
	"source_code" text NOT NULL,
	"source_hash" text NOT NULL,
	"submission_type" text NOT NULL,
	"runtime_image_digest" text NOT NULL,
	"test_bundle_id" uuid,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"domain" text NOT NULL,
	"description" text NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "concept_mastery" (
	"user_id" text NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"language_context" text DEFAULT 'conceptual' NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" "mastery_status" DEFAULT 'unseen' NOT NULL,
	"critical_requirements_met" boolean DEFAULT false NOT NULL,
	"last_evidence_at" timestamp with time zone,
	"last_practiced_at" timestamp with time zone,
	"next_review_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_mastery_user_id_enrollment_id_concept_id_language_context_pk" PRIMARY KEY("user_id","enrollment_id","concept_id","language_context"),
	CONSTRAINT "mastery_score_range" CHECK ("concept_mastery"."score" >= 0 AND "concept_mastery"."score" <= 1),
	CONSTRAINT "mastery_confidence_range" CHECK ("concept_mastery"."confidence" >= 0 AND "concept_mastery"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"domain" text NOT NULL,
	"icon" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "course_module" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_version_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"position" integer NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"version" text NOT NULL,
	"stage" "publication_stage" DEFAULT 'draft' NOT NULL,
	"scope_statement" text NOT NULL,
	"source_commit" text,
	"content_hash" text NOT NULL,
	"approved_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"to_email" text NOT NULL,
	"template" text NOT NULL,
	"template_version" text NOT NULL,
	"variables" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "enrollment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"course_version_id" uuid NOT NULL,
	"implementation_language" text,
	"status" "enrollment_status" DEFAULT 'planned' NOT NULL,
	"source" text DEFAULT 'self' NOT NULL,
	"placement_score" real,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_session_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "exam_status" DEFAULT 'scheduled' NOT NULL,
	"server_started_at" timestamp with time zone,
	"server_deadline_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"disconnected_seconds" integer DEFAULT 0 NOT NULL,
	"integrity_review_state" text DEFAULT 'not_required' NOT NULL,
	"finalized_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_request_id" uuid,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learner_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"self_reported_level" text DEFAULT 'beginner' NOT NULL,
	"preferred_session_minutes" integer DEFAULT 30 NOT NULL,
	"weekly_goal_minutes" integer DEFAULT 180 NOT NULL,
	"analogy_frequency" text DEFAULT 'helpful' NOT NULL,
	"analogy_interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"learning_goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"onboarding_step" text DEFAULT 'identity' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"public_alias" text,
	"bio" text,
	"profile_visibility" "visibility" DEFAULT 'cohort' NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"details" text NOT NULL,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"decision_by" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"enrollment_id" uuid,
	"plan_revision_id" uuid,
	"goal" text NOT NULL,
	"planned_minutes" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"difficulty" text NOT NULL,
	"position" integer NOT NULL,
	"content_status" "publication_stage" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"interest_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_concept" (
	"lesson_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"coverage" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	CONSTRAINT "lesson_concept_lesson_id_concept_id_pk" PRIMARY KEY("lesson_id","concept_id")
);
--> statement-breakpoint
CREATE TABLE "mastery_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"language_context" text DEFAULT 'conceptual' NOT NULL,
	"evidence_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"score" real NOT NULL,
	"weight" real NOT NULL,
	"critical_criterion" text,
	"validity" text DEFAULT 'valid' NOT NULL,
	"policy_version" text NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" uuid,
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"prompt_version" text NOT NULL,
	"context_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error_code" text,
	"request_hash" text NOT NULL,
	"response_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"action_url" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"parent_id" uuid,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"policy_version" text NOT NULL,
	"created_by" text,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prerequisite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_version_id" uuid NOT NULL,
	"from_concept_id" uuid NOT NULL,
	"to_concept_id" uuid NOT NULL,
	"minimum_mastery" real DEFAULT 0.8 NOT NULL,
	"rationale" text NOT NULL,
	CONSTRAINT "prerequisite_not_self" CHECK ("prerequisite"."from_concept_id" <> "prerequisite"."to_concept_id")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'idea' NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"prd" jsonb,
	"github_url" text,
	"github_commit_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"model_call_id" uuid,
	"findings" jsonb NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"label" text NOT NULL,
	"ciphertext" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"wrap_iv" text NOT NULL,
	"data_iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"last_four" text NOT NULL,
	"status" "credential_status" DEFAULT 'pending_validation' NOT NULL,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"failure_code" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_last_four_length" CHECK (char_length("provider_credential"."last_four") = 4)
);
--> statement-breakpoint
CREATE TABLE "provider_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"operation" text NOT NULL,
	"model" text NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_input_tokens" integer DEFAULT 16000 NOT NULL,
	"max_output_tokens" integer DEFAULT 2000 NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"object_id" uuid,
	"operation" text NOT NULL,
	"bytes" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"answer" jsonb NOT NULL,
	"source" text DEFAULT 'browser' NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"interval_days" integer NOT NULL,
	"ease_factor" real DEFAULT 2.5 NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"source_evidence_id" uuid,
	"completed_attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"limits" jsonb NOT NULL,
	"result" jsonb,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"device_hash" text,
	"device_label" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "learning_session_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"client_event_id" text NOT NULL,
	"type" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_time" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text,
	"project_id" uuid,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_object_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "test_bundle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"version" text NOT NULL,
	"encrypted_object_ref" text NOT NULL,
	"harness_hash" text NOT NULL,
	"runtime_image_digest" text NOT NULL,
	"visible_test_count" integer DEFAULT 0 NOT NULL,
	"hidden_test_count" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"role" text DEFAULT 'learner',
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"adult_confirmed_at" timestamp with time zone,
	"last_meaningful_activity_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_achievement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"achievement_id" uuid NOT NULL,
	"evidence_id" text NOT NULL,
	"visibility" "visibility" DEFAULT 'cohort' NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_lesson_id_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lesson"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "admin_fallback_grant_learner_id_user_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "admin_fallback_grant_credential_id_provider_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "admin_fallback_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_project_review_id_project_review_id_fk" FOREIGN KEY ("project_review_id") REFERENCES "public"."project_review"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_thread_id_chat_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_model_call_id_model_call_id_fk" FOREIGN KEY ("model_call_id") REFERENCES "public"."model_call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_submission" ADD CONSTRAINT "code_submission_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_submission" ADD CONSTRAINT "code_submission_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_submission" ADD CONSTRAINT "code_submission_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_submission" ADD CONSTRAINT "code_submission_test_bundle_id_test_bundle_id_fk" FOREIGN KEY ("test_bundle_id") REFERENCES "public"."test_bundle"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_mastery" ADD CONSTRAINT "concept_mastery_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_mastery" ADD CONSTRAINT "concept_mastery_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_mastery" ADD CONSTRAINT "concept_mastery_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_module" ADD CONSTRAINT "course_module_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_version" ADD CONSTRAINT "course_version_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_version" ADD CONSTRAINT "course_version_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_event" ADD CONSTRAINT "exam_event_exam_session_id_exam_session_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_session" ADD CONSTRAINT "exam_session_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_session" ADD CONSTRAINT "exam_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_access_request_id_access_request_id_fk" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_profile" ADD CONSTRAINT "learner_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_request" ADD CONSTRAINT "learning_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_request" ADD CONSTRAINT "learning_request_decision_by_user_id_fk" FOREIGN KEY ("decision_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_session" ADD CONSTRAINT "learning_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_session" ADD CONSTRAINT "learning_session_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_session" ADD CONSTRAINT "learning_session_plan_revision_id_plan_revision_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."plan_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_module_id_course_module_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."course_module"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_block" ADD CONSTRAINT "lesson_block_lesson_id_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lesson"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_concept" ADD CONSTRAINT "lesson_concept_lesson_id_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lesson"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_concept" ADD CONSTRAINT "lesson_concept_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_evidence" ADD CONSTRAINT "mastery_evidence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_evidence" ADD CONSTRAINT "mastery_evidence_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_evidence" ADD CONSTRAINT "mastery_evidence_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_credential_id_provider_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revision" ADD CONSTRAINT "plan_revision_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revision" ADD CONSTRAINT "plan_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisite" ADD CONSTRAINT "prerequisite_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisite" ADD CONSTRAINT "prerequisite_from_concept_id_concept_id_fk" FOREIGN KEY ("from_concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisite" ADD CONSTRAINT "prerequisite_to_concept_id_concept_id_fk" FOREIGN KEY ("to_concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review" ADD CONSTRAINT "project_review_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_review" ADD CONSTRAINT "project_review_model_call_id_model_call_id_fk" FOREIGN KEY ("model_call_id") REFERENCES "public"."model_call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_ledger" ADD CONSTRAINT "quota_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_ledger" ADD CONSTRAINT "quota_ledger_object_id_stored_object_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."stored_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response" ADD CONSTRAINT "response_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_source_evidence_id_mastery_evidence_id_fk" FOREIGN KEY ("source_evidence_id") REFERENCES "public"."mastery_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_job" ADD CONSTRAINT "runner_job_submission_id_code_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."code_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_session_event" ADD CONSTRAINT "learning_session_event_session_id_learning_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learning_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_session_event" ADD CONSTRAINT "learning_session_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_object" ADD CONSTRAINT "stored_object_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_object" ADD CONSTRAINT "stored_object_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_bundle" ADD CONSTRAINT "test_bundle_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievement" ADD CONSTRAINT "user_achievement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievement" ADD CONSTRAINT "user_achievement_achievement_id_achievement_id_fk" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_request_status_idx" ON "access_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "access_request_email_idx" ON "access_request" USING btree ("email");--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "fallback_grant_learner_idx" ON "admin_fallback_grant" USING btree ("learner_id","expires_at");--> statement-breakpoint
CREATE INDEX "appeal_status_idx" ON "appeal" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "attempt_user_time_idx" ON "attempt" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_time_idx" ON "audit_event" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_subject_time_idx" ON "audit_event" USING btree ("subject_user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_event_hash_unique" ON "audit_event" USING btree ("event_hash");--> statement-breakpoint
CREATE INDEX "background_job_queue_idx" ON "background_job" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "chat_message_thread_idx" ON "chat_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_thread_user_idx" ON "chat_thread" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "submission_user_time_idx" ON "code_submission" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mastery_review_idx" ON "concept_mastery" USING btree ("user_id","next_review_at");--> statement-breakpoint
CREATE UNIQUE INDEX "course_module_slug_unique" ON "course_module" USING btree ("course_version_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "course_module_position_unique" ON "course_module" USING btree ("course_version_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "course_version_unique" ON "course_version" USING btree ("course_id","version");--> statement-breakpoint
CREATE INDEX "email_outbox_queue_idx" ON "email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "enrollment_user_status_idx" ON "enrollment" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_event_idempotency" ON "exam_event" USING btree ("exam_session_id","client_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_attempt_unique" ON "exam_session" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_token_hash_unique" ON "invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "learning_request_status_idx" ON "learning_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "learning_session_user_idx" ON "learning_session" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_slug_unique" ON "lesson" USING btree ("module_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_position_unique" ON "lesson" USING btree ("module_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_block_position_unique" ON "lesson_block" USING btree ("lesson_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mastery_evidence_source_unique" ON "mastery_evidence" USING btree ("user_id","source_type","source_id","concept_id","critical_criterion");--> statement-breakpoint
CREATE INDEX "model_call_user_time_idx" ON "model_call" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_user_unread_idx" ON "notification" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_revision_unique" ON "plan_revision" USING btree ("enrollment_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "prerequisite_edge_unique" ON "prerequisite" USING btree ("course_version_id","from_concept_id","to_concept_id");--> statement-breakpoint
CREATE INDEX "project_user_idx" ON "project" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "credential_user_provider_idx" ON "provider_credential" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_idempotency_unique" ON "quota_ledger" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "quota_user_time_idx" ON "quota_ledger" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "response_revision_unique" ON "response" USING btree ("attempt_id","item_key","revision");--> statement-breakpoint
CREATE INDEX "review_due_idx" ON "review_schedule" USING btree ("user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "runner_queue_idx" ON "runner_job" USING btree ("status","priority","queued_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_active_device_idx" ON "session" USING btree ("user_id","device_hash","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_event_idempotency" ON "learning_session_event" USING btree ("user_id","client_event_id");--> statement-breakpoint
CREATE INDEX "stored_object_owner_idx" ON "stored_object" USING btree ("owner_user_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_user_unique" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "user_public_id_unique" ON "user" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "user_status_idx" ON "user" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_achievement_unique" ON "user_achievement" USING btree ("user_id","achievement_id","evidence_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");