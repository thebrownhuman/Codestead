UPDATE "learner_draft" SET "language" = 'text'
 WHERE "kind" = 'code' AND "language" IS NULL;--> statement-breakpoint
DROP INDEX "learner_draft_scope_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "learner_draft_scope_unique" ON "learner_draft" USING btree ("user_id","kind","course_id","skill_id",coalesce("language", ''));--> statement-breakpoint
ALTER TABLE "learner_draft" ADD CONSTRAINT "learner_draft_kind_language_check" CHECK (("learner_draft"."kind" = 'lesson' AND "learner_draft"."language" IS NULL) OR ("learner_draft"."kind" = 'code' AND "learner_draft"."language" IS NOT NULL));--> statement-breakpoint
CREATE OR REPLACE FUNCTION learner_draft_enforce_account_quota()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  existing_count bigint;
  existing_bytes bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'learner draft ownership is immutable';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('draft-account-quota:' || NEW.user_id, 0));
  SELECT count(*), coalesce(sum(octet_length(content)), 0)
    INTO existing_count, existing_bytes
    FROM learner_draft
   WHERE user_id = NEW.user_id
     AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF existing_count >= 512 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'learner draft record quota exceeded';
  END IF;
  IF existing_bytes + octet_length(NEW.content) > 33554432 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'learner draft byte quota exceeded';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER learner_draft_account_quota_guard
BEFORE INSERT OR UPDATE OF user_id, content ON learner_draft
FOR EACH ROW EXECUTE FUNCTION learner_draft_enforce_account_quota();
