ALTER TABLE "cohort_profile" ADD COLUMN "selected_achievement_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cohort_profile" ADD COLUMN "selected_project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cohort_profile" ADD CONSTRAINT "cohort_profile_achievement_selection_array" CHECK (jsonb_typeof("cohort_profile"."selected_achievement_ids") = 'array');--> statement-breakpoint
ALTER TABLE "cohort_profile" ADD CONSTRAINT "cohort_profile_project_selection_array" CHECK (jsonb_typeof("cohort_profile"."selected_project_ids") = 'array');