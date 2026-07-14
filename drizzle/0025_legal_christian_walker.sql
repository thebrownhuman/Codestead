CREATE TABLE "provider_operation_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"action" text NOT NULL,
	"request_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_operation_receipt_action_check" CHECK ("provider_operation_receipt"."action" IN ('tutor.post', 'credential.test', 'credential.replace')),
	CONSTRAINT "provider_operation_receipt_hash_shape" CHECK ("provider_operation_receipt"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "provider_operation_receipt_status_check" CHECK ("provider_operation_receipt"."status" IN ('processing', 'completed')),
	CONSTRAINT "provider_operation_receipt_response_status_check" CHECK ("provider_operation_receipt"."response_status" IS NULL OR "provider_operation_receipt"."response_status" BETWEEN 100 AND 599),
	CONSTRAINT "provider_operation_receipt_response_shape" CHECK (("provider_operation_receipt"."status" = 'processing' AND "provider_operation_receipt"."response_status" IS NULL AND "provider_operation_receipt"."response_body" IS NULL AND "provider_operation_receipt"."completed_at" IS NULL)
        OR ("provider_operation_receipt"."status" = 'completed' AND "provider_operation_receipt"."response_status" IS NOT NULL AND "provider_operation_receipt"."response_body" IS NOT NULL AND jsonb_typeof("provider_operation_receipt"."response_body") = 'object' AND "provider_operation_receipt"."completed_at" IS NOT NULL)),
	CONSTRAINT "provider_operation_receipt_response_size" CHECK ("provider_operation_receipt"."response_body" IS NULL OR octet_length("provider_operation_receipt"."response_body"::text) <= 262144)
);
--> statement-breakpoint
ALTER TABLE "provider_operation_receipt" ADD CONSTRAINT "provider_operation_receipt_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operation_receipt_owner_action_request_unique" ON "provider_operation_receipt" USING btree ("owner_user_id","action","request_id");--> statement-breakpoint
CREATE INDEX "provider_operation_receipt_owner_time_idx" ON "provider_operation_receipt" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_operation_receipt_processing_idx" ON "provider_operation_receipt" USING btree ("status","updated_at");