CREATE TABLE "admin_fallback_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"learner_id" text NOT NULL,
	"reserved_tokens" bigint NOT NULL,
	"reserved_paise" bigint NOT NULL,
	"actual_tokens" bigint,
	"actual_paise" bigint,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fallback_reservation_amount_check" CHECK ("admin_fallback_reservation"."reserved_tokens" > 0 AND "admin_fallback_reservation"."reserved_paise" > 0),
	CONSTRAINT "fallback_reservation_actual_check" CHECK (("admin_fallback_reservation"."actual_tokens" IS NULL AND "admin_fallback_reservation"."actual_paise" IS NULL) OR ("admin_fallback_reservation"."actual_tokens" BETWEEN 0 AND "admin_fallback_reservation"."reserved_tokens" AND "admin_fallback_reservation"."actual_paise" BETWEEN 0 AND "admin_fallback_reservation"."reserved_paise")),
	CONSTRAINT "fallback_reservation_status_check" CHECK ("admin_fallback_reservation"."status" IN ('reserved', 'reconciled')),
	CONSTRAINT "fallback_reservation_state_check" CHECK (("admin_fallback_reservation"."status" = 'reserved' AND "admin_fallback_reservation"."actual_tokens" IS NULL AND "admin_fallback_reservation"."actual_paise" IS NULL AND "admin_fallback_reservation"."reconciled_at" IS NULL) OR ("admin_fallback_reservation"."status" = 'reconciled' AND "admin_fallback_reservation"."actual_tokens" IS NOT NULL AND "admin_fallback_reservation"."actual_paise" IS NOT NULL AND "admin_fallback_reservation"."reconciled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "model" text DEFAULT 'legacy-unscoped-disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "rupee_budget_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "rupees_used_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "input_paise_per_million_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD COLUMN "output_paise_per_million_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_fallback_reservation" ADD CONSTRAINT "admin_fallback_reservation_grant_id_admin_fallback_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."admin_fallback_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_fallback_reservation" ADD CONSTRAINT "admin_fallback_reservation_learner_id_user_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fallback_reservation_grant_idx" ON "admin_fallback_reservation" USING btree ("grant_id","created_at");--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_model_length" CHECK (char_length("admin_fallback_grant"."model") BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_token_budget_check" CHECK ("admin_fallback_grant"."token_budget" > 0 AND "admin_fallback_grant"."tokens_used" >= 0 AND "admin_fallback_grant"."tokens_used" <= "admin_fallback_grant"."token_budget");--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_rupee_budget_check" CHECK ("admin_fallback_grant"."rupee_budget_paise" >= 0 AND "admin_fallback_grant"."rupees_used_paise" >= 0 AND "admin_fallback_grant"."rupees_used_paise" <= "admin_fallback_grant"."rupee_budget_paise");--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_pricing_check" CHECK ("admin_fallback_grant"."input_paise_per_million_tokens" >= 0 AND "admin_fallback_grant"."output_paise_per_million_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "admin_fallback_grant" ADD CONSTRAINT "fallback_grant_time_window_check" CHECK ("admin_fallback_grant"."expires_at" > "admin_fallback_grant"."starts_at");