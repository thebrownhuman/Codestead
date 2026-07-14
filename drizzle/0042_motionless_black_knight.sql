CREATE TABLE "daily_review_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"skill_id" text NOT NULL,
	"skill_title" text NOT NULL,
	"course_slug" text NOT NULL,
	"course_title" text NOT NULL,
	"concept_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"priority_reason" text NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"activity_id" uuid,
	"attempt_id" uuid,
	"score" real,
	"passed" boolean,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_review_item_position_check" CHECK ("daily_review_item"."position" BETWEEN 1 AND 5),
	CONSTRAINT "daily_review_item_skill_length_check" CHECK (char_length("daily_review_item"."skill_id") BETWEEN 1 AND 180),
	CONSTRAINT "daily_review_item_title_length_check" CHECK (char_length("daily_review_item"."skill_title") BETWEEN 1 AND 500),
	CONSTRAINT "daily_review_item_course_slug_length_check" CHECK (char_length("daily_review_item"."course_slug") BETWEEN 1 AND 100),
	CONSTRAINT "daily_review_item_course_title_length_check" CHECK (char_length("daily_review_item"."course_title") BETWEEN 1 AND 500),
	CONSTRAINT "daily_review_item_priority_check" CHECK ("daily_review_item"."priority_reason" IN ('confirmed_misconception', 'overdue_review', 'lowest_confidence')),
	CONSTRAINT "daily_review_item_confidence_check" CHECK ("daily_review_item"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "daily_review_item_status_check" CHECK ("daily_review_item"."status" IN ('pending', 'answered')),
	CONSTRAINT "daily_review_item_score_check" CHECK ("daily_review_item"."score" IS NULL OR ("daily_review_item"."score" >= 0 AND "daily_review_item"."score" <= 1)),
	CONSTRAINT "daily_review_item_answer_shape_check" CHECK (("daily_review_item"."status" = 'pending' AND "daily_review_item"."score" IS NULL AND "daily_review_item"."passed" IS NULL AND "daily_review_item"."answered_at" IS NULL)
        OR ("daily_review_item"."status" = 'answered' AND "daily_review_item"."attempt_id" IS NOT NULL AND "daily_review_item"."score" IS NOT NULL AND "daily_review_item"."passed" IS NOT NULL AND "daily_review_item"."answered_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "daily_review_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"local_date" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text NOT NULL,
	"available_item_count" integer DEFAULT 0 NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_review_session_local_date_check" CHECK ("daily_review_session"."local_date" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "daily_review_session_timezone_length_check" CHECK (char_length("daily_review_session"."timezone") BETWEEN 1 AND 100),
	CONSTRAINT "daily_review_session_status_check" CHECK ("daily_review_session"."status" IN ('ready', 'completed', 'unavailable')),
	CONSTRAINT "daily_review_session_available_count_check" CHECK ("daily_review_session"."available_item_count" BETWEEN 0 AND 100000),
	CONSTRAINT "daily_review_session_question_count_check" CHECK ("daily_review_session"."question_count" IN (0, 5)),
	CONSTRAINT "daily_review_session_completed_count_check" CHECK ("daily_review_session"."completed_count" BETWEEN 0 AND "daily_review_session"."question_count"),
	CONSTRAINT "daily_review_session_state_shape_check" CHECK (("daily_review_session"."status" = 'unavailable' AND "daily_review_session"."question_count" = 0 AND "daily_review_session"."completed_count" = 0 AND "daily_review_session"."completed_at" IS NULL)
        OR ("daily_review_session"."status" = 'ready' AND "daily_review_session"."question_count" = 5 AND "daily_review_session"."completed_count" BETWEEN 0 AND 4 AND "daily_review_session"."completed_at" IS NULL)
        OR ("daily_review_session"."status" = 'completed' AND "daily_review_session"."question_count" = 5 AND "daily_review_session"."completed_count" = 5 AND "daily_review_session"."completed_at" IS NOT NULL)),
	CONSTRAINT "daily_review_session_row_version_check" CHECK ("daily_review_session"."row_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_review_session_id_user_unique" ON "daily_review_session" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_daily_review_binding_unique" ON "attempt" USING btree ("id","user_id","activity_id","enrollment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_id_user_unique" ON "enrollment" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_session_id_daily_review_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."daily_review_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_session_owner_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."daily_review_session"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_enrollment_owner_fk" FOREIGN KEY ("enrollment_id","user_id") REFERENCES "public"."enrollment"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_item" ADD CONSTRAINT "daily_review_item_attempt_binding_fk" FOREIGN KEY ("attempt_id","user_id","activity_id","enrollment_id") REFERENCES "public"."attempt"("id","user_id","activity_id","enrollment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_review_session" ADD CONSTRAINT "daily_review_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_review_item_session_position_unique" ON "daily_review_item" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_review_item_session_skill_unique" ON "daily_review_item" USING btree ("session_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_review_item_attempt_unique" ON "daily_review_item" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_review_item_session_activity_unique" ON "daily_review_item" USING btree ("session_id","activity_id") WHERE "daily_review_item"."activity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "daily_review_item_owner_session_idx" ON "daily_review_item" USING btree ("user_id","session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_review_session_user_date_unique" ON "daily_review_session" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "daily_review_session_user_status_idx" ON "daily_review_session" USING btree ("user_id","status","local_date");
