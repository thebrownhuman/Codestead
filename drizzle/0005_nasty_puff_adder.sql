CREATE TABLE "auth_session_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"device_label" text,
	"user_agent" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"end_reason" text NOT NULL,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_revocation_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stored_object" ADD COLUMN "scan_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_object" ADD COLUMN "scan_lease_token" text;--> statement-breakpoint
ALTER TABLE "stored_object" ADD COLUMN "scan_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stored_object" ADD COLUMN "scan_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_object" ADD COLUMN "scan_error_code" text;--> statement-breakpoint
ALTER TABLE "stored_object" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
UPDATE "stored_object"
   SET "scan_status" = 'pending',
       "scan_next_attempt_at" = now(),
       "updated_at" = now()
 WHERE "scan_status" = 'basic_safe'
   AND "deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "auth_session_history" ADD CONSTRAINT "auth_session_history_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session_history" ADD CONSTRAINT "auth_session_history_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_revocation_request" ADD CONSTRAINT "session_revocation_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_revocation_request" ADD CONSTRAINT "session_revocation_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_history_original_unique" ON "auth_session_history" USING btree ("original_session_id");--> statement-breakpoint
CREATE INDEX "auth_session_history_user_time_idx" ON "auth_session_history" USING btree ("user_id","ended_at");--> statement-breakpoint
CREATE INDEX "session_revocation_request_user_idx" ON "session_revocation_request" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "session_revocation_request_status_idx" ON "session_revocation_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_revocation_request_pending_unique" ON "session_revocation_request" USING btree ("user_id","session_id") WHERE "session_revocation_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "stored_object_scan_queue_idx" ON "stored_object" USING btree ("scan_status","scan_next_attempt_at","scan_lease_expires_at");
