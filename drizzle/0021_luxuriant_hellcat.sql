CREATE TABLE "learner_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"course_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"language" text,
	"content" text NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_draft_kind_check" CHECK ("learner_draft"."kind" IN ('code', 'lesson')),
	CONSTRAINT "learner_draft_course_id_length" CHECK (char_length("learner_draft"."course_id") BETWEEN 1 AND 100),
	CONSTRAINT "learner_draft_skill_id_length" CHECK (char_length("learner_draft"."skill_id") BETWEEN 1 AND 180),
	CONSTRAINT "learner_draft_language_length" CHECK ("learner_draft"."language" IS NULL OR char_length("learner_draft"."language") BETWEEN 1 AND 40),
	CONSTRAINT "learner_draft_content_size" CHECK (octet_length("learner_draft"."content") <= 131072),
	CONSTRAINT "learner_draft_row_version_positive" CHECK ("learner_draft"."row_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "learner_draft_mutation" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"draft_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"expected_row_version" bigint NOT NULL,
	"resulting_row_version" bigint NOT NULL,
	"resulting_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_draft_mutation_hash_shape" CHECK ("learner_draft_mutation"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "learner_draft_mutation_expected_version_nonnegative" CHECK ("learner_draft_mutation"."expected_row_version" >= 0),
	CONSTRAINT "learner_draft_mutation_resulting_version_positive" CHECK ("learner_draft_mutation"."resulting_row_version" >= 1),
	CONSTRAINT "learner_draft_mutation_version_transition" CHECK ("learner_draft_mutation"."resulting_row_version" = "learner_draft_mutation"."expected_row_version" + 1)
);
--> statement-breakpoint
ALTER TABLE "learner_draft" ADD CONSTRAINT "learner_draft_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_draft_mutation" ADD CONSTRAINT "learner_draft_mutation_draft_id_learner_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."learner_draft"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learner_draft_scope_unique" ON "learner_draft" USING btree ("user_id","kind","course_id","skill_id");--> statement-breakpoint
CREATE INDEX "learner_draft_user_updated_idx" ON "learner_draft" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "learner_draft_mutation_draft_created_idx" ON "learner_draft_mutation" USING btree ("draft_id","created_at");