CREATE TABLE "storage_quota_change" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"learner_user_id" text NOT NULL,
	"learner_public_id" uuid NOT NULL,
	"requested_bytes" bigint NOT NULL,
	"expected_row_version" bigint NOT NULL,
	"previous_quota_bytes" bigint NOT NULL,
	"previous_row_version" bigint NOT NULL,
	"used_bytes_at_change" bigint NOT NULL,
	"resulting_row_version" bigint NOT NULL,
	"reason" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_quota_change_requested_bytes_check" CHECK ("storage_quota_change"."requested_bytes" BETWEEN 2147483648 AND 3221225472),
	CONSTRAINT "storage_quota_change_versions_check" CHECK ("storage_quota_change"."expected_row_version" >= 0 AND "storage_quota_change"."previous_row_version" >= 0 AND "storage_quota_change"."resulting_row_version" = "storage_quota_change"."previous_row_version" + 1),
	CONSTRAINT "storage_quota_change_usage_check" CHECK ("storage_quota_change"."used_bytes_at_change" >= 0 AND "storage_quota_change"."requested_bytes" >= "storage_quota_change"."used_bytes_at_change"),
	CONSTRAINT "storage_quota_change_previous_quota_check" CHECK ("storage_quota_change"."previous_quota_bytes" BETWEEN 2147483648 AND 3221225472),
	CONSTRAINT "storage_quota_change_reason_length" CHECK (char_length("storage_quota_change"."reason") BETWEEN 8 AND 500),
	CONSTRAINT "storage_quota_change_hash_check" CHECK ("storage_quota_change"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "storage_quota_change" ADD CONSTRAINT "storage_quota_change_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_quota_change" ADD CONSTRAINT "storage_quota_change_learner_user_id_user_id_fk" FOREIGN KEY ("learner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_quota_change_actor_time_idx" ON "storage_quota_change" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "storage_quota_change_learner_time_idx" ON "storage_quota_change" USING btree ("learner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_single_admin_unique" ON "user" USING btree ("role") WHERE "user"."role" = 'admin';