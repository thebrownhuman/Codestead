CREATE TABLE "curriculum_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_version_id" uuid NOT NULL,
	"artifact_key" text NOT NULL,
	"artifact_type" text NOT NULL,
	"skill_key" text,
	"source_path" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"publication_stage" text NOT NULL,
	"ai_assisted" boolean DEFAULT false NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_artifact_type_check" CHECK ("curriculum_artifact"."artifact_type" IN ('course_manifest', 'authored_lesson', 'assessment_bank')),
	CONSTRAINT "curriculum_artifact_hash_check" CHECK ("curriculum_artifact"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "curriculum_artifact_content_object_check" CHECK (jsonb_typeof("curriculum_artifact"."content") = 'object'),
	CONSTRAINT "curriculum_artifact_provenance_object_check" CHECK (jsonb_typeof("curriculum_artifact"."provenance") = 'object'),
	CONSTRAINT "curriculum_artifact_publication_stage_check" CHECK ("curriculum_artifact"."publication_stage" IN ('draft', 'in-review', 'approved', 'published', 'retired')),
	CONSTRAINT "curriculum_artifact_review_status_check" CHECK ("curriculum_artifact"."review_status" IN ('unreviewed', 'in_review', 'approved', 'changes_requested', 'rejected')),
	CONSTRAINT "curriculum_artifact_row_version_check" CHECK ("curriculum_artifact"."row_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "curriculum_publication_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"course_version_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"event" text NOT NULL,
	"request_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_publication_event_type_check" CHECK ("curriculum_publication_event"."event" IN ('candidate_staged', 'evidence_submitted', 'published_beta', 'promoted_verified', 'rolled_back', 'retired')),
	CONSTRAINT "curriculum_publication_event_reason_length" CHECK (char_length("curriculum_publication_event"."reason") BETWEEN 20 AND 2000),
	CONSTRAINT "curriculum_publication_event_evidence_object_check" CHECK (jsonb_typeof("curriculum_publication_event"."evidence") = 'object'),
	CONSTRAINT "curriculum_publication_event_hash_check" CHECK ("curriculum_publication_event"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "curriculum_publication_pointer" (
	"course_id" uuid PRIMARY KEY NOT NULL,
	"current_course_version_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_publication_pointer_version_check" CHECK ("curriculum_publication_pointer"."row_version" >= 1),
	CONSTRAINT "curriculum_publication_pointer_reason_length" CHECK (char_length("curriculum_publication_pointer"."reason") BETWEEN 20 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "curriculum_release_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_version_id" uuid NOT NULL,
	"submitted_by" text NOT NULL,
	"request_id" uuid NOT NULL,
	"evidence_version" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_release_evidence_content_hash_check" CHECK ("curriculum_release_evidence"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "curriculum_release_evidence_hash_check" CHECK ("curriculum_release_evidence"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "curriculum_release_evidence_object_check" CHECK (jsonb_typeof("curriculum_release_evidence"."evidence") = 'object'),
	CONSTRAINT "curriculum_release_evidence_version_check" CHECK ("curriculum_release_evidence"."evidence_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "curriculum_review_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"reviewer_kind" text NOT NULL,
	"decision" text NOT NULL,
	"request_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"resulting_version" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_review_event_reviewer_kind_check" CHECK ("curriculum_review_event"."reviewer_kind" = 'human'),
	CONSTRAINT "curriculum_review_event_decision_check" CHECK ("curriculum_review_event"."decision" IN ('approved', 'changes_requested', 'rejected')),
	CONSTRAINT "curriculum_review_event_hash_check" CHECK ("curriculum_review_event"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "curriculum_review_event_checklist_object_check" CHECK (jsonb_typeof("curriculum_review_event"."checklist") = 'object'),
	CONSTRAINT "curriculum_review_event_items_array_check" CHECK (jsonb_typeof("curriculum_review_event"."reviewed_item_ids") = 'array'),
	CONSTRAINT "curriculum_review_event_reason_length" CHECK (char_length("curriculum_review_event"."reason") BETWEEN 20 AND 2000),
	CONSTRAINT "curriculum_review_event_version_check" CHECK ("curriculum_review_event"."resulting_version" >= 2)
);
--> statement-breakpoint
ALTER TABLE "course_version" ADD COLUMN "publication_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "curriculum_artifact" ADD CONSTRAINT "curriculum_artifact_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_publication_event" ADD CONSTRAINT "curriculum_publication_event_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_publication_event" ADD CONSTRAINT "curriculum_publication_event_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_publication_event" ADD CONSTRAINT "curriculum_publication_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_publication_pointer" ADD CONSTRAINT "curriculum_publication_pointer_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_publication_pointer" ADD CONSTRAINT "curriculum_publication_pointer_current_course_version_id_course_version_id_fk" FOREIGN KEY ("current_course_version_id") REFERENCES "public"."course_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_publication_pointer" ADD CONSTRAINT "curriculum_publication_pointer_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_release_evidence" ADD CONSTRAINT "curriculum_release_evidence_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_release_evidence" ADD CONSTRAINT "curriculum_release_evidence_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_review_event" ADD CONSTRAINT "curriculum_review_event_artifact_id_curriculum_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."curriculum_artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_review_event" ADD CONSTRAINT "curriculum_review_event_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "curriculum_artifact_version_key_unique" ON "curriculum_artifact" USING btree ("course_version_id","artifact_key");--> statement-breakpoint
CREATE INDEX "curriculum_artifact_review_queue_idx" ON "curriculum_artifact" USING btree ("review_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "curriculum_publication_event_request_unique" ON "curriculum_publication_event" USING btree ("course_id","request_id");--> statement-breakpoint
CREATE INDEX "curriculum_publication_event_timeline_idx" ON "curriculum_publication_event" USING btree ("course_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "curriculum_publication_pointer_version_unique" ON "curriculum_publication_pointer" USING btree ("current_course_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "curriculum_release_evidence_request_unique" ON "curriculum_release_evidence" USING btree ("course_version_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "curriculum_release_evidence_version_unique" ON "curriculum_release_evidence" USING btree ("course_version_id","evidence_version");--> statement-breakpoint
CREATE INDEX "curriculum_release_evidence_timeline_idx" ON "curriculum_release_evidence" USING btree ("course_version_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "curriculum_review_event_request_unique" ON "curriculum_review_event" USING btree ("artifact_id","request_id");--> statement-breakpoint
CREATE INDEX "curriculum_review_event_timeline_idx" ON "curriculum_review_event" USING btree ("artifact_id","occurred_at");