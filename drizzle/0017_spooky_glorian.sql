CREATE TABLE "notification_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"quiet_hours_enabled" boolean DEFAULT true NOT NULL,
	"quiet_start_minute" integer DEFAULT 1320 NOT NULL,
	"quiet_end_minute" integer DEFAULT 480 NOT NULL,
	"inactivity_paused_until" timestamp with time zone,
	"inactivity_pause_reason" text,
	"inactivity_paused_by" text,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preference_quiet_start" CHECK ("notification_preference"."quiet_start_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "notification_preference_quiet_end" CHECK ("notification_preference"."quiet_end_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "notification_preference_pause_reason" CHECK ("notification_preference"."inactivity_paused_until" IS NULL OR char_length("notification_preference"."inactivity_pause_reason") BETWEEN 8 AND 500),
	CONSTRAINT "notification_preference_version" CHECK ("notification_preference"."row_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD COLUMN "eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD COLUMN "second_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD COLUMN "learner_first_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD COLUMN "admin_notice_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD COLUMN "learner_second_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD COLUMN "policy_version" text DEFAULT 'inactivity-2026-07.v2' NOT NULL;--> statement-breakpoint
UPDATE "inactivity_episode"
SET
	"eligible_at" = "last_activity_at" + interval '24 hours',
	"second_eligible_at" = "last_activity_at" + interval '72 hours',
	"learner_first_queued_at" = "reminder_sent_at"
WHERE "eligible_at" IS NULL OR "second_eligible_at" IS NULL;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ALTER COLUMN "eligible_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ALTER COLUMN "second_eligible_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_inactivity_paused_by_user_id_fk" FOREIGN KEY ("inactivity_paused_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD CONSTRAINT "inactivity_episode_threshold_order" CHECK ("inactivity_episode"."second_eligible_at" > "inactivity_episode"."eligible_at" AND "inactivity_episode"."eligible_at" > "inactivity_episode"."last_activity_at");
