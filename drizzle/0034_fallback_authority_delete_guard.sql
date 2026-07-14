CREATE OR REPLACE FUNCTION enforce_admin_fallback_grant_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.account_deletion_authorized', true) = '1' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Fallback grants cannot be deleted';
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_fallback_grant_delete_guard
BEFORE DELETE ON "admin_fallback_grant"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_fallback_grant_delete();
