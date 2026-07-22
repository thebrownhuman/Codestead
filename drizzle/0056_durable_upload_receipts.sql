CREATE TABLE "upload_receipt" (
	"owner_user_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"object_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_receipt_owner_user_id_idempotency_key_pk" PRIMARY KEY("owner_user_id","idempotency_key"),
	CONSTRAINT "upload_receipt_request_hash_check" CHECK ("upload_receipt"."request_hash" ~ '^v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "upload_receipt" ADD CONSTRAINT "upload_receipt_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_receipt" ADD CONSTRAINT "upload_receipt_object_id_stored_object_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."stored_object"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_receipt_object_unique" ON "upload_receipt" USING btree ("object_id");