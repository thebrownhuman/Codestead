CREATE TABLE "inactivity_episode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inactivity_episode" ADD CONSTRAINT "inactivity_episode_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inactivity_episode_user_idx" ON "inactivity_episode" USING btree ("user_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inactivity_episode_active_unique" ON "inactivity_episode" USING btree ("user_id") WHERE "inactivity_episode"."closed_at" IS NULL;