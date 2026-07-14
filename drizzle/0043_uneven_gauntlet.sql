CREATE TABLE "reward_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"reward_code" text NOT NULL,
	"scope_key" text NOT NULL,
	"attempt_id" uuid,
	"mastery_evidence_id" uuid,
	"source_event_id" uuid,
	"xp_delta" integer NOT NULL,
	"coin_delta" integer DEFAULT 0 NOT NULL,
	"policy_version" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_ledger_event_kind_check" CHECK ("reward_ledger"."event_kind" IN ('grant', 'revocation')),
	CONSTRAINT "reward_ledger_reward_code_check" CHECK ("reward_ledger"."reward_code" IN ('attempt_completion', 'concept_mastery')),
	CONSTRAINT "reward_ledger_scope_length_check" CHECK (char_length("reward_ledger"."scope_key") BETWEEN 3 AND 500),
	CONSTRAINT "reward_ledger_evidence_shape_check" CHECK (("reward_ledger"."attempt_id" IS NOT NULL)::int + ("reward_ledger"."mastery_evidence_id" IS NOT NULL)::int = 1),
	CONSTRAINT "reward_ledger_event_shape_check" CHECK (("reward_ledger"."event_kind" = 'grant' AND "reward_ledger"."source_event_id" IS NULL AND "reward_ledger"."xp_delta" > 0)
        OR ("reward_ledger"."event_kind" = 'revocation' AND "reward_ledger"."source_event_id" IS NOT NULL AND "reward_ledger"."xp_delta" < 0)),
	CONSTRAINT "reward_ledger_xp_bounds_check" CHECK ("reward_ledger"."xp_delta" BETWEEN -1000 AND 1000 AND "reward_ledger"."xp_delta" <> 0),
	CONSTRAINT "reward_ledger_coins_disabled_check" CHECK ("reward_ledger"."coin_delta" = 0),
	CONSTRAINT "reward_ledger_policy_length_check" CHECK (char_length("reward_ledger"."policy_version") BETWEEN 3 AND 100),
	CONSTRAINT "reward_ledger_request_hash_check" CHECK ("reward_ledger"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reward_ledger_reason_length_check" CHECK (char_length("reward_ledger"."reason") BETWEEN 8 AND 500)
);
--> statement-breakpoint
CREATE TABLE "reward_operation_receipt" (
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"input_hash" text NOT NULL,
	"event_id" uuid,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_operation_receipt_user_id_request_id_pk" PRIMARY KEY("user_id","request_id"),
	CONSTRAINT "reward_operation_receipt_operation_check" CHECK ("reward_operation_receipt"."operation" IN ('reconcile_attempt', 'reconcile_mastery')),
	CONSTRAINT "reward_operation_receipt_hash_check" CHECK ("reward_operation_receipt"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reward_operation_receipt_result_check" CHECK (jsonb_typeof("reward_operation_receipt"."result") = 'object')
);
--> statement-breakpoint
-- Composite owner keys must exist before PostgreSQL can create the strict
-- owner-bound foreign keys below. Drizzle emits indexes after foreign keys by
-- default, so these three generated indexes are intentionally ordered here.
CREATE UNIQUE INDEX "attempt_reward_owner_unique" ON "attempt" USING btree ("id","user_id","enrollment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mastery_evidence_reward_owner_unique" ON "mastery_evidence" USING btree ("id","user_id","enrollment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "reward_ledger_event_owner_unique" ON "reward_ledger" USING btree ("id","user_id");
--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_source_event_id_reward_ledger_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."reward_ledger"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_enrollment_owner_fk" FOREIGN KEY ("enrollment_id","user_id") REFERENCES "public"."enrollment"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_attempt_owner_fk" FOREIGN KEY ("attempt_id","user_id","enrollment_id") REFERENCES "public"."attempt"("id","user_id","enrollment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_mastery_owner_fk" FOREIGN KEY ("mastery_evidence_id","user_id","enrollment_id") REFERENCES "public"."mastery_evidence"("id","user_id","enrollment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_operation_receipt" ADD CONSTRAINT "reward_operation_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_operation_receipt" ADD CONSTRAINT "reward_operation_receipt_event_owner_fk" FOREIGN KEY ("event_id","user_id") REFERENCES "public"."reward_ledger"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_ledger_owner_request_unique" ON "reward_ledger" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_ledger_reversal_source_unique" ON "reward_ledger" USING btree ("source_event_id") WHERE "reward_ledger"."source_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reward_ledger_owner_time_idx" ON "reward_ledger" USING btree ("user_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "reward_ledger_owner_scope_idx" ON "reward_ledger" USING btree ("user_id","scope_key","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_operation_receipt_event_unique" ON "reward_operation_receipt" USING btree ("event_id") WHERE "reward_operation_receipt"."event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reward_operation_receipt_owner_time_idx" ON "reward_operation_receipt" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_reward_ledger_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row reward_ledger%ROWTYPE;
  attempt_row RECORD;
  mastery_row RECORD;
  expected_xp integer;
  expected_scope text;
  evidence_supported boolean;
BEGIN
  IF NEW.event_kind = 'grant' THEN
    IF NEW.policy_version <> 'reward-ledger-2026-07.v1' THEN
      RAISE EXCEPTION 'Unsupported reward policy version' USING ERRCODE = '23514';
    END IF;

    IF NEW.attempt_id IS NOT NULL THEN
      SELECT a.kind::text AS kind, a.status::text AS status, a.passed,
             a.mastery_awarded, a.infrastructure_failure, a.assistance_level,
             a.solution_revealed, a.activity_id, a.content_version, er.result AS effective_result
        INTO attempt_row
        FROM attempt a
        LEFT JOIN assessment_attempt_effective_result er
          ON er.attempt_id = a.id AND er.user_id = a.user_id
       WHERE a.id = NEW.attempt_id AND a.user_id = NEW.user_id
         AND a.enrollment_id = NEW.enrollment_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Reward attempt evidence is not owner-bound' USING ERRCODE = '23503';
      END IF;
      expected_xp := CASE attempt_row.kind
        WHEN 'quiz' THEN 20
        WHEN 'game' THEN 15
        WHEN 'mastery_check' THEN 40
        WHEN 'exam' THEN 100
        WHEN 'retake' THEN 80
        WHEN 'project' THEN 120
        ELSE 0
      END;
      expected_scope := CASE WHEN attempt_row.activity_id IS NOT NULL
        THEN 'activity:' || attempt_row.activity_id::text
        ELSE 'content:' || attempt_row.kind || ':' || left(replace(trim(attempt_row.content_version), ':', '_'), 180)
      END;
      IF attempt_row.effective_result IS NOT NULL THEN
        evidence_supported := attempt_row.effective_result ->> 'outcome' = 'MASTERED'
          AND NOT coalesce((attempt_row.effective_result ->> 'infrastructureFailure')::boolean, false);
      ELSE
        evidence_supported := attempt_row.passed IS NOT DISTINCT FROM true
          AND attempt_row.mastery_awarded IS NOT DISTINCT FROM true
          AND NOT attempt_row.infrastructure_failure;
      END IF;
      IF NEW.reward_code <> 'attempt_completion'
         OR NEW.scope_key <> expected_scope
         OR NEW.xp_delta <> expected_xp
         OR expected_xp = 0
         OR attempt_row.status <> 'graded'
         OR attempt_row.assistance_level <> 'A0'
         OR attempt_row.solution_revealed
         OR NOT evidence_supported THEN
        RAISE EXCEPTION 'Attempt does not support this reward grant' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT m.concept_id, m.language_context, m.validity, m.score, m.weight, m.recorded_by
        INTO mastery_row
        FROM mastery_evidence m
       WHERE m.id = NEW.mastery_evidence_id AND m.user_id = NEW.user_id
         AND m.enrollment_id = NEW.enrollment_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Reward mastery evidence is not owner-bound' USING ERRCODE = '23503';
      END IF;
      expected_scope := 'mastery:' || NEW.enrollment_id::text || ':' || mastery_row.concept_id::text || ':'
        || left(replace(trim(mastery_row.language_context), ':', '_'), 180);
      IF NEW.reward_code <> 'concept_mastery'
         OR NEW.scope_key <> expected_scope
         OR NEW.xp_delta <> 60
         OR mastery_row.validity <> 'valid'
         OR mastery_row.score < 0.8
         OR mastery_row.weight <= 0
         OR mastery_row.recorded_by IS NULL
         OR mastery_row.recorded_by NOT IN ('verified-runner', 'adaptive-deterministic-engine') THEN
        RAISE EXCEPTION 'Mastery evidence does not support this reward grant' USING ERRCODE = '23514';
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('reward-scope:' || NEW.user_id || ':' || NEW.scope_key, 0));
    IF EXISTS (
      SELECT 1 FROM reward_ledger grant_row
       WHERE grant_row.user_id = NEW.user_id
         AND grant_row.scope_key = NEW.scope_key
         AND grant_row.event_kind = 'grant'
         AND NOT EXISTS (
           SELECT 1 FROM reward_ledger reversal WHERE reversal.source_event_id = grant_row.id
         )
    ) THEN
      RAISE EXCEPTION 'Reward scope already has an active grant' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO source_row FROM reward_ledger WHERE id = NEW.source_event_id FOR KEY SHARE;
    IF NOT FOUND OR source_row.event_kind <> 'grant'
       OR NEW.user_id <> source_row.user_id
       OR NEW.enrollment_id <> source_row.enrollment_id
       OR NEW.reward_code <> source_row.reward_code
       OR NEW.scope_key <> source_row.scope_key
       OR NEW.attempt_id IS DISTINCT FROM source_row.attempt_id
       OR NEW.mastery_evidence_id IS DISTINCT FROM source_row.mastery_evidence_id
       OR NEW.xp_delta <> -source_row.xp_delta
       OR NEW.coin_delta <> -source_row.coin_delta
       OR NEW.policy_version <> source_row.policy_version
       OR NEW.occurred_at < source_row.occurred_at THEN
      RAISE EXCEPTION 'Reward revocation must exactly reverse its owner-bound grant' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reward_ledger_insert_guard
BEFORE INSERT ON reward_ledger
FOR EACH ROW EXECUTE FUNCTION enforce_reward_ledger_insert_v1();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_reward_append_only_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.account_deletion_authorized', true) = '1' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Reward history is append-only; corrections require a revocation event'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reward_ledger_append_only_guard
BEFORE UPDATE OR DELETE ON reward_ledger
FOR EACH ROW EXECUTE FUNCTION protect_reward_append_only_history();
--> statement-breakpoint
CREATE TRIGGER reward_operation_receipt_append_only_guard
BEFORE UPDATE OR DELETE ON reward_operation_receipt
FOR EACH ROW EXECUTE FUNCTION protect_reward_append_only_history();
