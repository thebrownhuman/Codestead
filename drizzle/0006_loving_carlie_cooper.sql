CREATE TABLE "api_rate_limit_window" (
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_rate_limit_window_pk" PRIMARY KEY("scope","key_hash","window_start"),
	CONSTRAINT "api_rate_limit_scope_check" CHECK (char_length("api_rate_limit_window"."scope") BETWEEN 1 AND 100),
	CONSTRAINT "api_rate_limit_key_hash_check" CHECK ("api_rate_limit_window"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_rate_limit_count_check" CHECK ("api_rate_limit_window"."request_count" BETWEEN 1 AND 1000001),
	CONSTRAINT "api_rate_limit_expiry_check" CHECK ("api_rate_limit_window"."expires_at" > "api_rate_limit_window"."window_start")
);
--> statement-breakpoint
CREATE INDEX "api_rate_limit_expiry_idx" ON "api_rate_limit_window" USING btree ("expires_at");