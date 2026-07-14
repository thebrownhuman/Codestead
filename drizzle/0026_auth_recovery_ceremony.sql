CREATE TABLE "lost_device_proof" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"proof_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lost_device_proof_hash_shape" CHECK ("lost_device_proof"."proof_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "lost_device_proof_expiry_window" CHECK ("lost_device_proof"."expires_at" > "lost_device_proof"."created_at" AND "lost_device_proof"."expires_at" <= "lost_device_proof"."created_at" + interval '30 minutes')
);
--> statement-breakpoint
ALTER TABLE "session_revocation_request" ADD COLUMN "request_channel" text DEFAULT 'authenticated' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_revocation_request" ADD COLUMN "identity_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_revocation_request" ADD COLUMN "proof_request_id" uuid;--> statement-breakpoint
ALTER TABLE "lost_device_proof" ADD CONSTRAINT "lost_device_proof_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lost_device_proof_hash_unique" ON "lost_device_proof" USING btree ("proof_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "lost_device_proof_open_unique" ON "lost_device_proof" USING btree ("user_id","session_id") WHERE "lost_device_proof"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "lost_device_proof_expiry_idx" ON "lost_device_proof" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "session_revocation_request" ADD CONSTRAINT "session_revocation_request_proof_request_id_lost_device_proof_id_fk" FOREIGN KEY ("proof_request_id") REFERENCES "public"."lost_device_proof"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_revocation_request_proof_unique" ON "session_revocation_request" USING btree ("proof_request_id") WHERE "session_revocation_request"."proof_request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "session_revocation_request" ADD CONSTRAINT "session_revocation_request_channel_check" CHECK (("session_revocation_request"."request_channel" = 'authenticated' AND "session_revocation_request"."proof_request_id" IS NULL) OR ("session_revocation_request"."request_channel" = 'email_proof' AND "session_revocation_request"."proof_request_id" IS NOT NULL AND "session_revocation_request"."identity_verified_at" IS NOT NULL));