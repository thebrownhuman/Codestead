CREATE TABLE "cohort_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"bio" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_consent_record_id" uuid,
	"show_bio" boolean DEFAULT false NOT NULL,
	"show_streak" boolean DEFAULT false NOT NULL,
	"show_mastery_summary" boolean DEFAULT false NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_profile_alias_check" CHECK ("cohort_profile"."alias" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$'),
	CONSTRAINT "cohort_profile_bio_length" CHECK ("cohort_profile"."bio" IS NULL OR char_length("cohort_profile"."bio") <= 280),
	CONSTRAINT "cohort_profile_version_check" CHECK ("cohort_profile"."row_version" >= 1),
	CONSTRAINT "cohort_profile_publication_consent_check" CHECK (NOT "cohort_profile"."is_published" OR "cohort_profile"."published_consent_record_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "cohort_profile_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"event" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"reason" text NOT NULL,
	"resulting_version" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_profile_event_type_check" CHECK ("cohort_profile_event"."event" IN ('created', 'updated', 'published', 'withdrawn')),
	CONSTRAINT "cohort_profile_event_snapshot_object_check" CHECK (jsonb_typeof("cohort_profile_event"."snapshot") = 'object'),
	CONSTRAINT "cohort_profile_event_hash_check" CHECK ("cohort_profile_event"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cohort_profile_event_reason_length" CHECK (char_length("cohort_profile_event"."reason") BETWEEN 8 AND 500),
	CONSTRAINT "cohort_profile_event_version_check" CHECK ("cohort_profile_event"."resulting_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "leaderboard_score_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"period_kind" text NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone,
	"formula_version" text NOT NULL,
	"revision" bigint NOT NULL,
	"total_points" integer NOT NULL,
	"components" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaderboard_score_period_kind_check" CHECK ("leaderboard_score_snapshot"."period_kind" IN ('weekly', 'all_time')),
	CONSTRAINT "leaderboard_score_period_key_length" CHECK (char_length("leaderboard_score_snapshot"."period_key") BETWEEN 3 AND 40),
	CONSTRAINT "leaderboard_score_formula_length" CHECK (char_length("leaderboard_score_snapshot"."formula_version") BETWEEN 3 AND 100),
	CONSTRAINT "leaderboard_score_revision_check" CHECK ("leaderboard_score_snapshot"."revision" >= 1),
	CONSTRAINT "leaderboard_score_points_check" CHECK ("leaderboard_score_snapshot"."total_points" >= 0),
	CONSTRAINT "leaderboard_score_components_object_check" CHECK (jsonb_typeof("leaderboard_score_snapshot"."components") = 'object'),
	CONSTRAINT "leaderboard_score_evidence_object_check" CHECK (jsonb_typeof("leaderboard_score_snapshot"."evidence") = 'object'),
	CONSTRAINT "leaderboard_score_hash_check" CHECK ("leaderboard_score_snapshot"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "leaderboard_score_period_order_check" CHECK ("leaderboard_score_snapshot"."period_end" IS NULL OR "leaderboard_score_snapshot"."period_end" > "leaderboard_score_snapshot"."period_start")
);
--> statement-breakpoint
ALTER TABLE "learner_profile" ALTER COLUMN "profile_visibility" SET DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "user_achievement" ALTER COLUMN "visibility" SET DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "cohort_profile" ADD CONSTRAINT "cohort_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_profile" ADD CONSTRAINT "cohort_profile_published_consent_record_id_consent_record_id_fk" FOREIGN KEY ("published_consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_profile_event" ADD CONSTRAINT "cohort_profile_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_profile_event" ADD CONSTRAINT "cohort_profile_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_score_snapshot" ADD CONSTRAINT "leaderboard_score_snapshot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_profile_alias_unique" ON "cohort_profile" USING btree (lower("alias"));--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_profile_event_request_unique" ON "cohort_profile_event" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "cohort_profile_event_timeline_idx" ON "cohort_profile_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_score_snapshot_revision_unique" ON "leaderboard_score_snapshot" USING btree ("user_id","period_kind","period_key","formula_version","revision");--> statement-breakpoint
CREATE INDEX "leaderboard_score_period_rank_idx" ON "leaderboard_score_snapshot" USING btree ("period_kind","period_key","formula_version","total_points");
--> statement-breakpoint
UPDATE "learner_profile" SET "profile_visibility" = 'private' WHERE "profile_visibility" <> 'private';
--> statement-breakpoint
UPDATE "user_achievement" SET "visibility" = 'private' WHERE "visibility" <> 'private';
--> statement-breakpoint
UPDATE "project" SET "visibility" = 'private' WHERE "visibility" <> 'private';
--> statement-breakpoint
CREATE FUNCTION "reject_social_evidence_update"() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'social evidence records are append-only'
    USING ERRCODE = '23514';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "cohort_profile_event_append_only_trigger"
BEFORE UPDATE ON "cohort_profile_event"
FOR EACH ROW EXECUTE FUNCTION "reject_social_evidence_update"();
--> statement-breakpoint
CREATE TRIGGER "leaderboard_score_snapshot_append_only_trigger"
BEFORE UPDATE ON "leaderboard_score_snapshot"
FOR EACH ROW EXECUTE FUNCTION "reject_social_evidence_update"();
