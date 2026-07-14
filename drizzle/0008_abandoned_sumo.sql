CREATE TABLE "account_deletion_tombstone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"identity_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"requested_by_user_id" text,
	"primary_deletion_completed_at" timestamp with time zone NOT NULL,
	"backup_retention_until" timestamp with time zone NOT NULL,
	"backup_status" text DEFAULT 'awaiting_retention_expiry' NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_identity_hash_length" CHECK ("account_deletion_tombstone"."identity_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "account_deletion_backup_status_check" CHECK ("account_deletion_tombstone"."backup_status" IN ('awaiting_retention_expiry', 'eligible_for_operator_verification', 'verified_expired')),
	CONSTRAINT "account_deletion_policy_version_length" CHECK (char_length("account_deletion_tombstone"."policy_version") BETWEEN 1 AND 100),
	CONSTRAINT "account_deletion_backup_window_check" CHECK ("account_deletion_tombstone"."backup_retention_until" >= "account_deletion_tombstone"."primary_deletion_completed_at"),
	CONSTRAINT "account_deletion_report_object_check" CHECK (jsonb_typeof("account_deletion_tombstone"."report") = 'object')
);
--> statement-breakpoint
CREATE TABLE "data_lifecycle_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" text NOT NULL,
	"policy_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"cutoff_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" text,
	"target_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_lifecycle_run_operation_check" CHECK ("data_lifecycle_run"."operation" IN ('retention', 'export', 'account_deletion')),
	CONSTRAINT "data_lifecycle_run_policy_version_length" CHECK (char_length("data_lifecycle_run"."policy_version") BETWEEN 1 AND 100),
	CONSTRAINT "data_lifecycle_run_idempotency_key_length" CHECK (char_length("data_lifecycle_run"."idempotency_key") BETWEEN 8 AND 300),
	CONSTRAINT "data_lifecycle_run_json_object_check" CHECK (jsonb_typeof("data_lifecycle_run"."cutoff_manifest") = 'object' AND jsonb_typeof("data_lifecycle_run"."report") = 'object')
);
--> statement-breakpoint
ALTER TABLE "stored_object" ADD COLUMN "retention_class" text DEFAULT 'user_upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletion_tombstone" ADD CONSTRAINT "account_deletion_tombstone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletion_tombstone" ADD CONSTRAINT "account_deletion_tombstone_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_lifecycle_run" ADD CONSTRAINT "data_lifecycle_run_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_lifecycle_run" ADD CONSTRAINT "data_lifecycle_run_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_tombstone_user_unique" ON "account_deletion_tombstone" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_deletion_tombstone_backup_idx" ON "account_deletion_tombstone" USING btree ("backup_status","backup_retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "data_lifecycle_run_idempotency_unique" ON "data_lifecycle_run" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "data_lifecycle_run_status_idx" ON "data_lifecycle_run" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "stored_object_retention_idx" ON "stored_object" USING btree ("retention_class","scan_status","created_at");--> statement-breakpoint
ALTER TABLE "stored_object" ADD CONSTRAINT "stored_object_retention_class_check" CHECK ("stored_object"."retention_class" IN ('user_upload', 'ai_request_attachment', 'temporary'));
