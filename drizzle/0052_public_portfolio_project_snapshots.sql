-- This forward migration intentionally contains two privacy/replay repairs that
-- landed after the 0051 snapshot: durable community operation receipts, and an
-- immutable allowlisted project projection for each explicit portfolio publish.
-- Existing published selections have no snapshot and therefore remain hidden
-- until the learner explicitly republishes them through the validated boundary.
CREATE TABLE "community_operation_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"action" text NOT NULL,
	"input_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_operation_receipt_action_check" CHECK ("community_operation_receipt"."action" IN ('create_group','add_member','create_post','reply')),
	CONSTRAINT "community_operation_receipt_hash_check" CHECK ("community_operation_receipt"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "community_operation_receipt_result_object" CHECK (jsonb_typeof("community_operation_receipt"."result") = 'object')
);
--> statement-breakpoint
CREATE TABLE "public_portfolio_project_snapshot" (
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"portfolio_version" bigint NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" text NOT NULL,
	"github_url" text NOT NULL,
	"source_project_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_portfolio_project_snapshot_user_id_project_id_portfolio_version_pk" PRIMARY KEY("user_id","project_id","portfolio_version"),
	CONSTRAINT "public_portfolio_project_snapshot_version_check" CHECK ("public_portfolio_project_snapshot"."portfolio_version" >= 1),
	CONSTRAINT "public_portfolio_project_snapshot_title_length" CHECK (char_length("public_portfolio_project_snapshot"."title") BETWEEN 1 AND 100),
	CONSTRAINT "public_portfolio_project_snapshot_summary_length" CHECK (char_length("public_portfolio_project_snapshot"."summary") BETWEEN 1 AND 1000),
	CONSTRAINT "public_portfolio_project_snapshot_github_url_check" CHECK ("public_portfolio_project_snapshot"."github_url" ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
);
--> statement-breakpoint
ALTER TABLE "community_operation_receipt" ADD CONSTRAINT "community_operation_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_project_snapshot" ADD CONSTRAINT "public_portfolio_project_snapshot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_portfolio_project_snapshot" ADD CONSTRAINT "public_portfolio_project_snapshot_owner_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."project"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_operation_receipt_user_request_unique" ON "community_operation_receipt" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "community_operation_receipt_user_time_idx" ON "community_operation_receipt" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "public_portfolio_project_snapshot_version_idx" ON "public_portfolio_project_snapshot" USING btree ("user_id","portfolio_version");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public_portfolio_project_snapshot_update_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'public_portfolio_project_snapshot is immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "public_portfolio_project_snapshot_update_guard"
BEFORE UPDATE ON "public_portfolio_project_snapshot"
FOR EACH ROW EXECUTE FUNCTION "public_portfolio_project_snapshot_update_guard"();
