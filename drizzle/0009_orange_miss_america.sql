CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"policy_version" text NOT NULL,
	"decision" text NOT NULL,
	"data_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_record_purpose_length" CHECK (char_length("consent_record"."purpose") BETWEEN 2 AND 100),
	CONSTRAINT "consent_record_policy_version_length" CHECK (char_length("consent_record"."policy_version") BETWEEN 3 AND 100),
	CONSTRAINT "consent_record_decision_check" CHECK ("consent_record"."decision" IN ('accepted', 'withdrawn')),
	CONSTRAINT "consent_record_source_check" CHECK ("consent_record"."source" IN ('onboarding', 'settings', 'system_migration')),
	CONSTRAINT "consent_record_categories_array_check" CHECK (jsonb_typeof("consent_record"."data_categories") = 'array'),
	CONSTRAINT "consent_record_idempotency_length" CHECK (char_length("consent_record"."idempotency_key") BETWEEN 8 AND 200)
);
--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_record_idempotency_unique" ON "consent_record" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "consent_record_user_purpose_time_idx" ON "consent_record" USING btree ("user_id","purpose","occurred_at");
