CREATE TABLE "coding_battle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_user_id" text,
	"create_request_id" uuid NOT NULL,
	"create_input_hash" text NOT NULL,
	"activity_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"competition_key" text,
	"title" text NOT NULL,
	"language" text NOT NULL,
	"skill_key" text NOT NULL,
	"challenge_kind" text NOT NULL,
	"immutable_snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"scoring_version" text DEFAULT 'battle-score-v1' NOT NULL,
	"max_points" integer DEFAULT 100 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reveal_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_battle_scope_check" CHECK ("coding_battle"."scope" IN ('invite', 'cohort', 'weekly', 'monthly')),
	CONSTRAINT "coding_battle_create_input_hash" CHECK ("coding_battle"."create_input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "coding_battle_competition_shape" CHECK (("coding_battle"."scope" IN ('weekly','monthly')) = ("coding_battle"."competition_key" IS NOT NULL)),
	CONSTRAINT "coding_battle_competition_key_length" CHECK ("coding_battle"."competition_key" IS NULL OR char_length("coding_battle"."competition_key") BETWEEN 7 AND 40),
	CONSTRAINT "coding_battle_title_length" CHECK (char_length("coding_battle"."title") BETWEEN 3 AND 160),
	CONSTRAINT "coding_battle_language_length" CHECK (char_length("coding_battle"."language") BETWEEN 1 AND 80),
	CONSTRAINT "coding_battle_skill_length" CHECK (char_length("coding_battle"."skill_key") BETWEEN 2 AND 160),
	CONSTRAINT "coding_battle_kind_check" CHECK ("coding_battle"."challenge_kind" IN ('authored_answer', 'verified_attempt')),
	CONSTRAINT "coding_battle_snapshot_object" CHECK (jsonb_typeof("coding_battle"."immutable_snapshot") = 'object'),
	CONSTRAINT "coding_battle_snapshot_hash" CHECK ("coding_battle"."snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "coding_battle_scoring_version_length" CHECK (char_length("coding_battle"."scoring_version") BETWEEN 3 AND 100),
	CONSTRAINT "coding_battle_points_check" CHECK ("coding_battle"."max_points" BETWEEN 1 AND 1000),
	CONSTRAINT "coding_battle_status_check" CHECK ("coding_battle"."status" IN ('active', 'cancelled')),
	CONSTRAINT "coding_battle_time_order" CHECK ("coding_battle"."starts_at" < "coding_battle"."ends_at" AND "coding_battle"."ends_at" <= "coding_battle"."reveal_at")
);
--> statement-breakpoint
CREATE TABLE "coding_battle_participant" (
	"battle_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_battle_participant_battle_id_user_id_pk" PRIMARY KEY("battle_id","user_id"),
	CONSTRAINT "coding_battle_participant_role_check" CHECK ("coding_battle_participant"."role" IN ('creator', 'invited', 'joined'))
);
--> statement-breakpoint
CREATE TABLE "coding_battle_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"battle_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"answer" jsonb NOT NULL,
	"answer_hash" text NOT NULL,
	"source_attempt_id" uuid,
	"score" integer NOT NULL,
	"passed" boolean NOT NULL,
	"result_evidence" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_battle_submission_input_hash" CHECK ("coding_battle_submission"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "coding_battle_submission_answer_object" CHECK (jsonb_typeof("coding_battle_submission"."answer") = 'object'),
	CONSTRAINT "coding_battle_submission_answer_hash" CHECK ("coding_battle_submission"."answer_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "coding_battle_submission_score" CHECK ("coding_battle_submission"."score" BETWEEN 0 AND 1000),
	CONSTRAINT "coding_battle_submission_evidence_object" CHECK (jsonb_typeof("coding_battle_submission"."result_evidence") = 'object')
);
--> statement-breakpoint
CREATE TABLE "community_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"visibility" text DEFAULT 'members' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_group_name_length" CHECK (char_length("community_group"."name") BETWEEN 3 AND 80),
	CONSTRAINT "community_group_description_length" CHECK (char_length("community_group"."description") BETWEEN 10 AND 500),
	CONSTRAINT "community_group_visibility_check" CHECK ("community_group"."visibility" IN ('cohort', 'members')),
	CONSTRAINT "community_group_status_check" CHECK ("community_group"."status" IN ('active', 'archived')),
	CONSTRAINT "community_group_version_check" CHECK ("community_group"."row_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "community_group_member" (
	"group_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_group_member_group_id_user_id_pk" PRIMARY KEY("group_id","user_id"),
	CONSTRAINT "community_group_member_role_check" CHECK ("community_group_member"."role" IN ('owner', 'moderator', 'member'))
);
--> statement-breakpoint
CREATE TABLE "community_moderation_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"report_id" uuid,
	"post_id" uuid,
	"reply_id" uuid,
	"action" text NOT NULL,
	"prior_state" text NOT NULL,
	"resulting_state" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_moderation_target_check" CHECK (num_nonnulls("community_moderation_event"."post_id", "community_moderation_event"."reply_id") = 1),
	CONSTRAINT "community_moderation_action_check" CHECK ("community_moderation_event"."action" IN ('hide', 'restore', 'delete')),
	CONSTRAINT "community_moderation_state_check" CHECK ("community_moderation_event"."prior_state" IN ('active', 'hidden', 'deleted') AND "community_moderation_event"."resulting_state" IN ('active', 'hidden', 'deleted')),
	CONSTRAINT "community_moderation_reason_length" CHECK (char_length("community_moderation_event"."reason") BETWEEN 8 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "community_post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"moderated_by_user_id" text,
	"moderation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_post_kind_check" CHECK ("community_post"."kind" IN ('discussion', 'help', 'project_share')),
	CONSTRAINT "community_post_title_length" CHECK (char_length("community_post"."title") BETWEEN 3 AND 160),
	CONSTRAINT "community_post_body_length" CHECK (char_length("community_post"."body") BETWEEN 10 AND 8000),
	CONSTRAINT "community_post_hash_check" CHECK ("community_post"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "community_post_state_check" CHECK ("community_post"."state" IN ('active', 'hidden', 'deleted')),
	CONSTRAINT "community_post_version_check" CHECK ("community_post"."row_version" >= 1),
	CONSTRAINT "community_post_deletion_shape" CHECK (("community_post"."state" <> 'deleted' AND "community_post"."deleted_at" IS NULL) OR ("community_post"."state" = 'deleted' AND "community_post"."deleted_at" IS NOT NULL)),
	CONSTRAINT "community_post_moderation_shape" CHECK (("community_post"."moderated_by_user_id" IS NULL AND "community_post"."moderation_reason" IS NULL) OR ("community_post"."moderated_by_user_id" IS NOT NULL AND char_length("community_post"."moderation_reason") BETWEEN 8 AND 1000))
);
--> statement-breakpoint
CREATE TABLE "community_reply" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"moderated_by_user_id" text,
	"moderation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_reply_body_length" CHECK (char_length("community_reply"."body") BETWEEN 2 AND 4000),
	CONSTRAINT "community_reply_hash_check" CHECK ("community_reply"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "community_reply_state_check" CHECK ("community_reply"."state" IN ('active', 'hidden', 'deleted')),
	CONSTRAINT "community_reply_version_check" CHECK ("community_reply"."row_version" >= 1),
	CONSTRAINT "community_reply_deletion_shape" CHECK (("community_reply"."state" <> 'deleted' AND "community_reply"."deleted_at" IS NULL) OR ("community_reply"."state" = 'deleted' AND "community_reply"."deleted_at" IS NOT NULL)),
	CONSTRAINT "community_reply_moderation_shape" CHECK (("community_reply"."moderated_by_user_id" IS NULL AND "community_reply"."moderation_reason" IS NULL) OR ("community_reply"."moderated_by_user_id" IS NOT NULL AND char_length("community_reply"."moderation_reason") BETWEEN 8 AND 1000))
);
--> statement-breakpoint
CREATE TABLE "community_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" text NOT NULL,
	"post_id" uuid,
	"reply_id" uuid,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by_user_id" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_report_target_check" CHECK (num_nonnulls("community_report"."post_id", "community_report"."reply_id") = 1),
	CONSTRAINT "community_report_reason_check" CHECK ("community_report"."reason" IN ('harassment', 'unsafe_code', 'spam', 'privacy', 'other')),
	CONSTRAINT "community_report_details_length" CHECK ("community_report"."details" IS NULL OR char_length("community_report"."details") BETWEEN 4 AND 1000),
	CONSTRAINT "community_report_status_check" CHECK ("community_report"."status" IN ('open', 'resolved', 'dismissed')),
	CONSTRAINT "community_report_decision_shape" CHECK (("community_report"."status" = 'open' AND "community_report"."decided_by_user_id" IS NULL AND "community_report"."decision_reason" IS NULL AND "community_report"."decided_at" IS NULL)
        OR ("community_report"."status" <> 'open' AND "community_report"."decided_by_user_id" IS NOT NULL AND char_length("community_report"."decision_reason") BETWEEN 8 AND 1000 AND "community_report"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "smart_reminder_dispatch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"local_period_key" text NOT NULL,
	"timezone" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smart_reminder_kind_check" CHECK ("smart_reminder_dispatch"."kind" IN ('daily_study', 'revision', 'goal', 'challenge', 'weekly_summary')),
	CONSTRAINT "smart_reminder_period_length" CHECK (char_length("smart_reminder_dispatch"."local_period_key") BETWEEN 8 AND 32),
	CONSTRAINT "smart_reminder_timezone_length" CHECK (char_length("smart_reminder_dispatch"."timezone") BETWEEN 1 AND 100),
	CONSTRAINT "smart_reminder_evidence_object" CHECK (jsonb_typeof("smart_reminder_dispatch"."evidence") = 'object')
);
--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "daily_study_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "revision_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "goal_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "challenge_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "weekly_summary_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "learning_email_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "daily_study_minute" integer DEFAULT 1080 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "revision_minute" integer DEFAULT 1140 NOT NULL;--> statement-breakpoint
ALTER TABLE "coding_battle" ADD CONSTRAINT "coding_battle_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_battle" ADD CONSTRAINT "coding_battle_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_battle_participant" ADD CONSTRAINT "coding_battle_participant_battle_id_coding_battle_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."coding_battle"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_battle_participant" ADD CONSTRAINT "coding_battle_participant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_battle_submission" ADD CONSTRAINT "coding_battle_submission_source_attempt_id_attempt_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "public"."attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_battle_submission" ADD CONSTRAINT "coding_battle_submission_participant_fk" FOREIGN KEY ("battle_id","user_id") REFERENCES "public"."coding_battle_participant"("battle_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_group" ADD CONSTRAINT "community_group_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_group_member" ADD CONSTRAINT "community_group_member_group_id_community_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."community_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_group_member" ADD CONSTRAINT "community_group_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderation_event" ADD CONSTRAINT "community_moderation_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderation_event" ADD CONSTRAINT "community_moderation_event_report_id_community_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."community_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderation_event" ADD CONSTRAINT "community_moderation_event_post_id_community_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderation_event" ADD CONSTRAINT "community_moderation_event_reply_id_community_reply_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."community_reply"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post" ADD CONSTRAINT "community_post_group_id_community_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."community_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post" ADD CONSTRAINT "community_post_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post" ADD CONSTRAINT "community_post_moderated_by_user_id_user_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reply" ADD CONSTRAINT "community_reply_post_id_community_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reply" ADD CONSTRAINT "community_reply_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reply" ADD CONSTRAINT "community_reply_moderated_by_user_id_user_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_report" ADD CONSTRAINT "community_report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_report" ADD CONSTRAINT "community_report_post_id_community_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_report" ADD CONSTRAINT "community_report_reply_id_community_reply_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."community_reply"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_report" ADD CONSTRAINT "community_report_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_reminder_dispatch" ADD CONSTRAINT "smart_reminder_dispatch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coding_battle_creator_request_unique" ON "coding_battle" USING btree ("creator_user_id","create_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coding_battle_competition_key_unique" ON "coding_battle" USING btree ("competition_key") WHERE "coding_battle"."competition_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "coding_battle_discovery_idx" ON "coding_battle" USING btree ("status","scope","starts_at","reveal_at");--> statement-breakpoint
CREATE INDEX "coding_battle_participant_user_idx" ON "coding_battle_participant" USING btree ("user_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coding_battle_submission_participant_unique" ON "coding_battle_submission" USING btree ("battle_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coding_battle_submission_request_unique" ON "coding_battle_submission" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "coding_battle_submission_result_idx" ON "coding_battle_submission" USING btree ("battle_id","score","submitted_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_group_name_unique" ON "community_group" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "community_group_visibility_status_idx" ON "community_group" USING btree ("visibility","status","created_at");--> statement-breakpoint
CREATE INDEX "community_group_member_user_idx" ON "community_group_member" USING btree ("user_id","joined_at");--> statement-breakpoint
CREATE INDEX "community_moderation_target_time_idx" ON "community_moderation_event" USING btree ("post_id","reply_id","occurred_at");--> statement-breakpoint
CREATE INDEX "community_post_group_feed_idx" ON "community_post" USING btree ("group_id","state","created_at","id");--> statement-breakpoint
CREATE INDEX "community_post_author_idx" ON "community_post" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "community_reply_post_timeline_idx" ON "community_reply" USING btree ("post_id","state","created_at","id");--> statement-breakpoint
CREATE INDEX "community_reply_author_idx" ON "community_reply" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "community_report_post_reporter_unique" ON "community_report" USING btree ("reporter_user_id","post_id") WHERE "community_report"."post_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "community_report_reply_reporter_unique" ON "community_report" USING btree ("reporter_user_id","reply_id") WHERE "community_report"."reply_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "community_report_queue_idx" ON "community_report" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_reminder_user_kind_period_unique" ON "smart_reminder_dispatch" USING btree ("user_id","kind","local_period_key");--> statement-breakpoint
CREATE INDEX "smart_reminder_user_time_idx" ON "smart_reminder_dispatch" USING btree ("user_id","dispatched_at");--> statement-breakpoint
CREATE INDEX "smart_reminder_schedule_idx" ON "smart_reminder_dispatch" USING btree ("scheduled_for","kind");--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_daily_minute" CHECK ("notification_preference"."daily_study_minute" BETWEEN 0 AND 1439);--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_revision_minute" CHECK ("notification_preference"."revision_minute" BETWEEN 0 AND 1439);--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_timezone_length" CHECK (char_length("notification_preference"."timezone") BETWEEN 1 AND 100);
--> statement-breakpoint
CREATE FUNCTION "community_battle_append_only_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.account_deletion_authorized', true) = '1' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "community_moderation_event_append_only_trigger"
BEFORE UPDATE OR DELETE ON "community_moderation_event"
FOR EACH ROW EXECUTE FUNCTION "community_battle_append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "coding_battle_submission_append_only_trigger"
BEFORE UPDATE OR DELETE ON "coding_battle_submission"
FOR EACH ROW EXECUTE FUNCTION "community_battle_append_only_guard"();
--> statement-breakpoint
CREATE FUNCTION "coding_battle_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.account_deletion_authorized', true) = '1' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'coding_battle cannot be deleted outside account deletion' USING ERRCODE = '55000';
  END IF;
  IF (NEW.creator_user_id IS DISTINCT FROM OLD.creator_user_id
        AND NOT (current_setting('app.account_deletion_authorized', true) = '1'
          AND OLD.creator_user_id IS NOT NULL AND NEW.creator_user_id IS NULL))
     OR NEW.create_request_id IS DISTINCT FROM OLD.create_request_id
     OR NEW.create_input_hash IS DISTINCT FROM OLD.create_input_hash
     OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.competition_key IS DISTINCT FROM OLD.competition_key
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.skill_key IS DISTINCT FROM OLD.skill_key
     OR NEW.challenge_kind IS DISTINCT FROM OLD.challenge_kind
     OR NEW.immutable_snapshot IS DISTINCT FROM OLD.immutable_snapshot
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
     OR NEW.scoring_version IS DISTINCT FROM OLD.scoring_version
     OR NEW.max_points IS DISTINCT FROM OLD.max_points
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.reveal_at IS DISTINCT FROM OLD.reveal_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'coding_battle definition is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "coding_battle_immutable_guard_trigger"
BEFORE UPDATE OR DELETE ON "coding_battle"
FOR EACH ROW EXECUTE FUNCTION "coding_battle_immutable_guard"();
--> statement-breakpoint
CREATE FUNCTION "coding_battle_submission_shape_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE battle_kind text; battle_points integer;
BEGIN
  SELECT challenge_kind,max_points INTO battle_kind,battle_points FROM coding_battle WHERE id=NEW.battle_id;
  IF battle_kind IS NULL OR NEW.score > battle_points THEN
    RAISE EXCEPTION 'battle submission score is outside its immutable definition' USING ERRCODE = '23514';
  END IF;
  IF (battle_kind='verified_attempt') <> (NEW.source_attempt_id IS NOT NULL) THEN
    RAISE EXCEPTION 'battle submission evidence does not match challenge kind' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "coding_battle_submission_shape_guard_trigger"
BEFORE INSERT ON "coding_battle_submission"
FOR EACH ROW EXECUTE FUNCTION "coding_battle_submission_shape_guard"();
