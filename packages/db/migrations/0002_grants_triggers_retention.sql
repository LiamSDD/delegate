GRANT SELECT ON TABLE users, orgs, workspaces TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (display_name) ON TABLE users TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (name, slug) ON TABLE workspaces TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE members TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (role) ON TABLE members TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE runs, artifacts, approvals TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE policies, memories, documents, chunks TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE run_events, audit_log TO delegate_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE run_events, audit_log FROM delegate_app, PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE run_events_id_seq, audit_log_id_seq TO delegate_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER run_events_append_only
BEFORE UPDATE OR DELETE ON run_events
FOR EACH ROW EXECUTE FUNCTION app_reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER run_events_no_truncate
BEFORE TRUNCATE ON run_events
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION app_reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_default_demo_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_demo AND NEW.retention_days IS NULL THEN
    NEW.retention_days := 7;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER workspaces_demo_retention
BEFORE INSERT OR UPDATE OF is_demo, retention_days ON workspaces
FOR EACH ROW EXECUTE FUNCTION app_default_demo_retention();
