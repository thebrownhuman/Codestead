CREATE TABLE "reward_reconciliation_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"attempt_id" uuid,
	"mastery_evidence_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_reconciliation_job_operation_check" CHECK ("reward_reconciliation_job"."operation" IN ('reconcile_attempt', 'reconcile_mastery')),
	CONSTRAINT "reward_reconciliation_job_evidence_shape_check" CHECK (("reward_reconciliation_job"."attempt_id" IS NOT NULL)::int + ("reward_reconciliation_job"."mastery_evidence_id" IS NOT NULL)::int = 1),
	CONSTRAINT "reward_reconciliation_job_operation_shape_check" CHECK (("reward_reconciliation_job"."operation" = 'reconcile_attempt' AND "reward_reconciliation_job"."attempt_id" IS NOT NULL)
        OR ("reward_reconciliation_job"."operation" = 'reconcile_mastery' AND "reward_reconciliation_job"."mastery_evidence_id" IS NOT NULL)),
	CONSTRAINT "reward_reconciliation_job_status_check" CHECK ("reward_reconciliation_job"."status" IN ('pending', 'running', 'complete')),
	CONSTRAINT "reward_reconciliation_job_generation_check" CHECK ("reward_reconciliation_job"."generation" >= 1),
	CONSTRAINT "reward_reconciliation_job_attempt_count_check" CHECK ("reward_reconciliation_job"."attempt_count" >= 0),
	CONSTRAINT "reward_reconciliation_job_lease_shape_check" CHECK (("reward_reconciliation_job"."status" = 'running' AND "reward_reconciliation_job"."lease_token" IS NOT NULL AND "reward_reconciliation_job"."lease_expires_at" IS NOT NULL)
        OR ("reward_reconciliation_job"."status" <> 'running' AND "reward_reconciliation_job"."lease_token" IS NULL AND "reward_reconciliation_job"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD COLUMN "evidence_occurred_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "reward_ledger" DISABLE TRIGGER reward_ledger_append_only_guard;--> statement-breakpoint
UPDATE reward_ledger ledger
   SET evidence_occurred_at = least(
     ledger.occurred_at,
     coalesce(
       (select case when effective.attempt_id is not null then effective.updated_at else source_attempt.graded_at end
          from attempt source_attempt
          left join assessment_attempt_effective_result effective
            on effective.attempt_id = source_attempt.id and effective.user_id = source_attempt.user_id
         where source_attempt.id = ledger.attempt_id and source_attempt.user_id = ledger.user_id),
       (select evidence.recorded_at from mastery_evidence evidence
         where evidence.id = ledger.mastery_evidence_id and evidence.user_id = ledger.user_id),
       ledger.occurred_at
     )
   )
 where ledger.event_kind = 'grant';--> statement-breakpoint
UPDATE reward_ledger reversal
   SET evidence_occurred_at = source.evidence_occurred_at
  FROM reward_ledger source
 where reversal.source_event_id = source.id and reversal.event_kind = 'revocation';--> statement-breakpoint
ALTER TABLE "reward_ledger" ENABLE TRIGGER reward_ledger_append_only_guard;--> statement-breakpoint
ALTER TABLE "reward_reconciliation_job" ADD CONSTRAINT "reward_reconciliation_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_reconciliation_job" ADD CONSTRAINT "reward_reconciliation_job_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_reconciliation_job" ADD CONSTRAINT "reward_reconciliation_job_mastery_evidence_id_mastery_evidence_id_fk" FOREIGN KEY ("mastery_evidence_id") REFERENCES "public"."mastery_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_reconciliation_job_attempt_unique" ON "reward_reconciliation_job" USING btree ("attempt_id") WHERE "reward_reconciliation_job"."attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_reconciliation_job_mastery_unique" ON "reward_reconciliation_job" USING btree ("mastery_evidence_id") WHERE "reward_reconciliation_job"."mastery_evidence_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reward_reconciliation_job_queue_idx" ON "reward_reconciliation_job" USING btree ("status","next_attempt_at","updated_at");--> statement-breakpoint
CREATE INDEX "reward_ledger_owner_evidence_time_idx" ON "reward_ledger" USING btree ("user_id","evidence_occurred_at","id");--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_evidence_time_check" CHECK ("reward_ledger"."evidence_occurred_at" <= "reward_ledger"."occurred_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_reward_jobs_for_attempt_v1(
  p_attempt_id uuid,
  p_user_id text,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO reward_reconciliation_job
    (user_id, operation, attempt_id, status, generation, attempt_count,
     next_attempt_at, lease_token, lease_expires_at, last_error_code, created_at, updated_at)
  SELECT candidate.user_id, 'reconcile_attempt', candidate.id, 'pending', 1, 0,
         p_now, null::uuid, null::timestamptz, null::text, p_now, p_now
    FROM attempt changed
    JOIN attempt candidate
      ON candidate.user_id = changed.user_id
     AND candidate.enrollment_id IS NOT NULL
     AND (
       (changed.activity_id IS NOT NULL AND candidate.activity_id = changed.activity_id)
       OR (changed.activity_id IS NULL AND candidate.activity_id IS NULL
         AND candidate.kind = changed.kind AND candidate.content_version = changed.content_version)
     )
   WHERE changed.id = p_attempt_id AND changed.user_id = p_user_id
  ON CONFLICT (attempt_id) WHERE attempt_id IS NOT NULL DO UPDATE
    SET status = 'pending', generation = reward_reconciliation_job.generation + 1,
        attempt_count = 0, next_attempt_at = excluded.next_attempt_at,
        lease_token = null, lease_expires_at = null, last_error_code = null,
        updated_at = excluded.updated_at;

  INSERT INTO reward_reconciliation_job
    (user_id, operation, mastery_evidence_id, status, generation, attempt_count,
     next_attempt_at, lease_token, lease_expires_at, last_error_code, created_at, updated_at)
  SELECT DISTINCT sibling.user_id, 'reconcile_mastery', sibling.id, 'pending', 1, 0,
         p_now, null::uuid, null::timestamptz, null::text, p_now, p_now
    FROM mastery_evidence evidence
    LEFT JOIN assessment_mastery_projection_repair repair
      ON repair.projection_evidence_id = evidence.id and repair.user_id = evidence.user_id
    JOIN mastery_evidence sibling
      ON sibling.user_id = evidence.user_id
     AND sibling.enrollment_id = evidence.enrollment_id
     AND sibling.concept_id = evidence.concept_id
     AND sibling.language_context = evidence.language_context
   WHERE evidence.user_id = p_user_id
     AND (evidence.source_id = p_attempt_id::text OR repair.attempt_id = p_attempt_id)
  ON CONFLICT (mastery_evidence_id) WHERE mastery_evidence_id IS NOT NULL DO UPDATE
    SET status = 'pending', generation = reward_reconciliation_job.generation + 1,
        attempt_count = 0, next_attempt_at = excluded.next_attempt_at,
        lease_token = null, lease_expires_at = null, last_error_code = null,
        updated_at = excluded.updated_at;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_reward_jobs_for_mastery_scope_v1(
  p_mastery_evidence_id uuid,
  p_user_id text,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO reward_reconciliation_job
    (user_id, operation, mastery_evidence_id, status, generation, attempt_count,
     next_attempt_at, lease_token, lease_expires_at, last_error_code, created_at, updated_at)
  SELECT sibling.user_id, 'reconcile_mastery', sibling.id, 'pending', 1, 0,
         p_now, null::uuid, null::timestamptz, null::text, p_now, p_now
    FROM mastery_evidence changed
    JOIN mastery_evidence sibling
      ON sibling.user_id = changed.user_id
     AND sibling.enrollment_id = changed.enrollment_id
     AND sibling.concept_id = changed.concept_id
     AND sibling.language_context = changed.language_context
   WHERE changed.id = p_mastery_evidence_id AND changed.user_id = p_user_id
  ON CONFLICT (mastery_evidence_id) WHERE mastery_evidence_id IS NOT NULL DO UPDATE
    SET status = 'pending', generation = reward_reconciliation_job.generation + 1,
        attempt_count = 0, next_attempt_at = excluded.next_attempt_at,
        lease_token = null, lease_expires_at = null, last_error_code = null,
        updated_at = excluded.updated_at;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_reward_attempt_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.enrollment_id IS NOT NULL THEN
    PERFORM enqueue_reward_jobs_for_attempt_v1(NEW.id, NEW.user_id, now());
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER reward_attempt_reconciliation_enqueue
AFTER INSERT OR UPDATE OF status, passed, mastery_awarded, infrastructure_failure,
  assistance_level, solution_revealed, graded_at
ON attempt
FOR EACH ROW EXECUTE FUNCTION enqueue_reward_attempt_change_v1();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_reward_mastery_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM enqueue_reward_jobs_for_mastery_scope_v1(NEW.id, NEW.user_id, now());
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER reward_mastery_reconciliation_enqueue
AFTER INSERT OR UPDATE OF validity, score, weight, recorded_by, recorded_at, source_type, source_id
ON mastery_evidence
FOR EACH ROW EXECUTE FUNCTION enqueue_reward_mastery_change_v1();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_reward_effective_result_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM enqueue_reward_jobs_for_attempt_v1(NEW.attempt_id, NEW.user_id, now());
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER reward_effective_result_reconciliation_enqueue
AFTER INSERT OR UPDATE OF outcome_id, result, result_hash, revision, updated_at
ON assessment_attempt_effective_result
FOR EACH ROW EXECUTE FUNCTION enqueue_reward_effective_result_change_v1();--> statement-breakpoint

INSERT INTO reward_reconciliation_job
  (user_id, operation, attempt_id, status, generation, attempt_count,
   next_attempt_at, created_at, updated_at)
SELECT source_attempt.user_id, 'reconcile_attempt', source_attempt.id, 'pending', 1, 0,
       now(), now(), now()
  FROM attempt source_attempt
 WHERE source_attempt.enrollment_id IS NOT NULL
ON CONFLICT (attempt_id) WHERE attempt_id IS NOT NULL DO NOTHING;--> statement-breakpoint

INSERT INTO reward_reconciliation_job
  (user_id, operation, mastery_evidence_id, status, generation, attempt_count,
   next_attempt_at, created_at, updated_at)
SELECT evidence.user_id, 'reconcile_mastery', evidence.id, 'pending', 1, 0,
       now(), now(), now()
  FROM mastery_evidence evidence
ON CONFLICT (mastery_evidence_id) WHERE mastery_evidence_id IS NOT NULL DO NOTHING;--> statement-breakpoint

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
  expected_evidence_at timestamptz;
  evidence_supported boolean;
BEGIN
  IF NEW.evidence_occurred_at > NEW.occurred_at THEN
    RAISE EXCEPTION 'Reward evidence timestamp cannot follow ledger occurrence' USING ERRCODE = '23514';
  END IF;

  IF NEW.event_kind = 'grant' THEN
    IF NEW.policy_version <> 'reward-ledger-2026-07.v1' THEN
      RAISE EXCEPTION 'Unsupported reward policy version' USING ERRCODE = '23514';
    END IF;

    IF NEW.attempt_id IS NOT NULL THEN
      SELECT a.kind::text AS kind, a.status::text AS status, a.passed,
             a.mastery_awarded, a.infrastructure_failure, a.assistance_level,
             a.solution_revealed, a.activity_id, a.content_version,
             effective.result AS effective_result,
             CASE WHEN effective.attempt_id IS NOT NULL THEN effective.updated_at ELSE a.graded_at END AS evidence_at
        INTO attempt_row
        FROM attempt a
        LEFT JOIN assessment_attempt_effective_result effective
          ON effective.attempt_id = a.id AND effective.user_id = a.user_id
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
      expected_evidence_at := attempt_row.evidence_at;
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
         OR NOT evidence_supported
         OR expected_evidence_at IS NULL
         OR NEW.evidence_occurred_at IS DISTINCT FROM expected_evidence_at THEN
        RAISE EXCEPTION 'Attempt does not support this reward grant' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT evidence.concept_id, evidence.language_context, evidence.validity,
             evidence.score, evidence.weight, evidence.recorded_by, evidence.source_type,
             evidence.recorded_at AS evidence_at,
             source_attempt.id AS source_attempt_id,
             source_attempt.status::text AS source_attempt_status,
             source_attempt.passed AS source_attempt_passed,
             source_attempt.mastery_awarded AS source_attempt_mastery_awarded,
             source_attempt.infrastructure_failure AS source_attempt_infrastructure_failure,
             source_attempt.assistance_level AS source_attempt_assistance_level,
             source_attempt.solution_revealed AS source_attempt_solution_revealed,
             source_effective.result AS source_effective_result,
             coalesce(source_activity.concept_id = evidence.concept_id
               OR (repair.projection_evidence_id = evidence.id
                 AND repair.concept_id = evidence.concept_id AND repair.status = 'applied'), false) AS concept_bound
        INTO mastery_row
        FROM mastery_evidence evidence
        LEFT JOIN assessment_mastery_projection_repair repair
          ON repair.projection_evidence_id = evidence.id AND repair.user_id = evidence.user_id
        LEFT JOIN attempt source_attempt
          ON source_attempt.id = CASE
            WHEN evidence.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN evidence.source_id::uuid
            ELSE repair.attempt_id
          END
         AND source_attempt.user_id = evidence.user_id
         AND source_attempt.enrollment_id = evidence.enrollment_id
        LEFT JOIN activity source_activity ON source_activity.id = source_attempt.activity_id
        LEFT JOIN assessment_attempt_effective_result source_effective
          ON source_effective.attempt_id = source_attempt.id
         AND source_effective.user_id = source_attempt.user_id
       WHERE evidence.id = NEW.mastery_evidence_id AND evidence.user_id = NEW.user_id
         AND evidence.enrollment_id = NEW.enrollment_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Reward mastery evidence is not owner-bound' USING ERRCODE = '23503';
      END IF;
      expected_scope := 'mastery:' || NEW.enrollment_id::text || ':' || mastery_row.concept_id::text || ':'
        || left(replace(trim(mastery_row.language_context), ':', '_'), 180);
      expected_evidence_at := mastery_row.evidence_at;
      IF mastery_row.source_effective_result IS NOT NULL THEN
        evidence_supported := mastery_row.source_effective_result ->> 'outcome' = 'MASTERED'
          AND NOT coalesce((mastery_row.source_effective_result ->> 'infrastructureFailure')::boolean, false);
      ELSE
        evidence_supported := mastery_row.source_attempt_passed IS NOT DISTINCT FROM true
          AND mastery_row.source_attempt_mastery_awarded IS NOT DISTINCT FROM true
          AND mastery_row.source_attempt_infrastructure_failure IS NOT DISTINCT FROM false;
      END IF;
      IF NEW.reward_code <> 'concept_mastery'
         OR NEW.scope_key <> expected_scope
         OR NEW.xp_delta <> 60
         OR mastery_row.validity <> 'valid'
         OR mastery_row.score < 0.8
         OR mastery_row.weight <= 0
         OR mastery_row.recorded_by IS NULL
         OR mastery_row.recorded_by NOT IN ('verified-runner', 'adaptive-deterministic-engine')
         OR mastery_row.source_type NOT IN ('attempt', 'deterministic_attempt', 'verified_runner', 'assessment_correction')
         OR mastery_row.source_attempt_id IS NULL
         OR mastery_row.source_attempt_status <> 'graded'
         OR mastery_row.source_attempt_assistance_level <> 'A0'
         OR mastery_row.source_attempt_solution_revealed
         OR NOT mastery_row.concept_bound
         OR NOT evidence_supported
         OR NEW.evidence_occurred_at IS DISTINCT FROM expected_evidence_at THEN
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
       OR NEW.evidence_occurred_at IS DISTINCT FROM source_row.evidence_occurred_at
       OR NEW.occurred_at < source_row.occurred_at THEN
      RAISE EXCEPTION 'Reward revocation must exactly reverse its owner-bound grant' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
