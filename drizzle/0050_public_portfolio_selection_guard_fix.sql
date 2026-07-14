DROP TRIGGER IF EXISTS "public_portfolio_project_selection_guard_trigger" ON "public_portfolio_project";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "public_portfolio_achievement_selection_guard_trigger" ON "public_portfolio_achievement";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "public_portfolio_certificate_selection_guard_trigger" ON "public_portfolio_certificate";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public_portfolio_selection_guard"();
--> statement-breakpoint
CREATE FUNCTION "public_portfolio_project_selection_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM project owned
     WHERE owned.id = NEW.project_id AND owned.user_id = NEW.user_id
       AND owned.github_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'
  ) THEN
    RAISE EXCEPTION 'portfolio project requires an owner-bound public GitHub repository URL' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "public_portfolio_achievement_selection_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_achievement owned
     WHERE owned.id = NEW.user_achievement_id AND owned.user_id = NEW.user_id
       AND owned.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'portfolio achievement must be current and owner-bound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "public_portfolio_certificate_selection_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM course_certificate owned
     WHERE owned.id = NEW.certificate_id AND owned.user_id = NEW.user_id
       AND NOT EXISTS (
         SELECT 1 FROM certificate_revocation revoked WHERE revoked.certificate_id = owned.id
       )
  ) THEN
    RAISE EXCEPTION 'portfolio certificate must be current and owner-bound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "public_portfolio_project_selection_guard_trigger"
BEFORE INSERT OR UPDATE ON "public_portfolio_project"
FOR EACH ROW EXECUTE FUNCTION "public_portfolio_project_selection_guard"();
--> statement-breakpoint
CREATE TRIGGER "public_portfolio_achievement_selection_guard_trigger"
BEFORE INSERT OR UPDATE ON "public_portfolio_achievement"
FOR EACH ROW EXECUTE FUNCTION "public_portfolio_achievement_selection_guard"();
--> statement-breakpoint
CREATE TRIGGER "public_portfolio_certificate_selection_guard_trigger"
BEFORE INSERT OR UPDATE ON "public_portfolio_certificate"
FOR EACH ROW EXECUTE FUNCTION "public_portfolio_certificate_selection_guard"();
