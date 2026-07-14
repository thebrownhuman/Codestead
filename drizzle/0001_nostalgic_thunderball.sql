ALTER TABLE "learner_profile" ADD COLUMN "selected_tracks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "learner_profile" ADD COLUMN "dsa_language" text;