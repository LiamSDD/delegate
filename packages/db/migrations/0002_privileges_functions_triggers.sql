ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT (id, display_name, kind, created_at) ON TABLE users TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (display_name) ON TABLE users TO delegate_app;
--> statement-breakpoint
GRANT SELECT ON TABLE orgs, workspaces TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (name, slug) ON TABLE workspaces TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE members TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (role) ON TABLE members TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE runs TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (status, started_at, finished_at) ON TABLE runs TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE artifacts TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE approvals TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE policies, memories, documents, chunks TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE run_events TO delegate_app;
--> statement-breakpoint
GRANT SELECT ON TABLE audit_log TO delegate_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE run_events_id_seq TO delegate_app;
--> statement-breakpoint
GRANT SELECT ON TABLE users, workspaces, members, policies TO delegate_definer;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE runs TO delegate_definer;
--> statement-breakpoint
GRANT UPDATE (totals) ON TABLE runs TO delegate_definer;
--> statement-breakpoint
GRANT SELECT ON TABLE approvals TO delegate_definer;
--> statement-breakpoint
GRANT UPDATE (status, resolved_at, resolved_by) ON TABLE approvals TO delegate_definer;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE audit_log TO delegate_definer;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE audit_log_id_seq TO delegate_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  call_stack text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('delegate.retention_purge', true) = 'on' THEN
    GET DIAGNOSTICS call_stack = PG_CONTEXT;
    IF call_stack LIKE '%PL/pgSQL function purge_expired_demo_runs() %' THEN
      RETURN OLD;
    END IF;
  END IF;
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
SET search_path = pg_catalog, public
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_guard_approval_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'approvals.run_id is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'approvals.workspace_id is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.step_id IS DISTINCT FROM OLD.step_id THEN
    RAISE EXCEPTION 'approvals.step_id is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.action IS DISTINCT FROM OLD.action THEN
    RAISE EXCEPTION 'approvals.action is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'approvals.requested_at is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    OR (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by AND NEW.resolved_by IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'approvals: a resolved approval cannot change (it is %)', OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_guard_update
BEFORE UPDATE ON approvals
FOR EACH ROW EXECUTE FUNCTION app_guard_approval_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_guard_run_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  field text;
BEGIN
  IF NEW.budget IS DISTINCT FROM OLD.budget THEN
    RAISE EXCEPTION 'runs.budget is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.mission IS DISTINCT FROM OLD.mission
    OR NEW.input IS DISTINCT FROM OLD.input
    OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.forked_from_seq IS DISTINCT FROM OLD.forked_from_seq
    OR NEW.prompt_versions IS DISTINCT FROM OLD.prompt_versions
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'runs: workspace_id, mission, input, parent_run_id, forked_from_seq, prompt_versions and created_at are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL THEN
    RAISE EXCEPTION 'runs.created_by is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH field IN ARRAY ARRAY['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costMicroUsd'] LOOP
    IF coalesce((NEW.totals ->> field)::bigint, -1) < coalesce((OLD.totals ->> field)::bigint, 0) THEN
      RAISE EXCEPTION 'runs.totals cannot decrease (%)', field USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER runs_guard_update
BEFORE UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION app_guard_run_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_keep_workspace_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  loses_owner boolean := OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner');
BEGIN
  IF loses_owner THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('delegate.workspace_owners:' || OLD.workspace_id::text, 0));
    IF EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.members m
        WHERE m.workspace_id = OLD.workspace_id AND m.role = 'owner' AND m.id <> OLD.id
      ) THEN
      RAISE EXCEPTION 'members: workspace % must keep at least one owner', OLD.workspace_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app_keep_workspace_owner() OWNER TO delegate_definer;
--> statement-breakpoint
CREATE TRIGGER members_keep_owner
BEFORE UPDATE OR DELETE ON members
FOR EACH ROW EXECUTE FUNCTION app_keep_workspace_owner();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_approval(approval_id uuid, decision text)
RETURNS public.approvals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  target_workspace uuid;
  caller_role text;
  caller_kind public.user_kind;
  run_creator uuid;
  target public.approvals;
BEGIN
  IF decision IS NULL OR decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'resolve_approval: decision must be approved or rejected'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT a.workspace_id INTO target_workspace FROM public.approvals a WHERE a.id = approval_id;
  caller_role := CASE WHEN target_workspace IS NULL THEN NULL ELSE public.app_workspace_role(target_workspace) END;
  IF caller IS NULL OR caller_role IS NULL THEN
    RAISE EXCEPTION 'resolve_approval: approval not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF caller_role NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'resolve_approval: requires operator, admin or owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT u.kind INTO caller_kind FROM public.users u WHERE u.id = caller;
  IF caller_kind IS DISTINCT FROM 'member' AND caller_kind IS DISTINCT FROM 'guest' THEN
    RAISE EXCEPTION 'resolve_approval: agents cannot resolve approvals' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO target FROM public.approvals a WHERE a.id = approval_id FOR UPDATE;
  IF target.status <> 'pending' THEN
    RAISE EXCEPTION 'resolve_approval: approval is already %', target.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT r.created_by INTO run_creator FROM public.runs r WHERE r.id = target.run_id;
  IF decision = 'approved' AND run_creator = caller AND caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'resolve_approval: an operator cannot approve an action on a run they created'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.approvals a
  SET status = decision::public.approval_status, resolved_at = now(), resolved_by = caller
  WHERE a.id = approval_id
  RETURNING * INTO target;
  INSERT INTO public.audit_log (workspace_id, actor_type, actor_id, action, target, decision, approval_id, details)
  VALUES (
    target.workspace_id, 'user', caller, 'approval.' || decision, 'approval:' || target.id::text,
    'n/a', target.id, jsonb_build_object('runId', target.run_id, 'stepId', target.step_id, 'role', caller_role)
  );
  RETURN target;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_audit(
  workspace_id uuid,
  action text,
  target text,
  decision public.audit_decision,
  policy_id uuid,
  approval_id uuid,
  details jsonb,
  actor_type public.audit_actor_type DEFAULT 'user'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  caller_kind public.user_kind;
  entry_id bigint;
BEGIN
  IF actor_type IS NULL OR action IS NULL OR decision IS NULL OR workspace_id IS NULL THEN
    RAISE EXCEPTION 'record_audit: workspace_id, action, decision and actor_type are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF actor_type IN ('system', 'agent') AND NOT pg_has_role(session_user, 'delegate_system', 'MEMBER') THEN
    RAISE EXCEPTION 'record_audit: % entries require the delegate_system role', actor_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF actor_type = 'system' THEN
    IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = record_audit.workspace_id) THEN
      RAISE EXCEPTION 'record_audit: workspace % not found', record_audit.workspace_id
        USING ERRCODE = 'no_data_found';
    END IF;
  ELSE
    IF caller IS NULL OR public.app_workspace_role(record_audit.workspace_id) IS NULL THEN
      RAISE EXCEPTION 'record_audit: caller is not a member of workspace %', record_audit.workspace_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT u.kind INTO caller_kind FROM public.users u WHERE u.id = caller;
    IF actor_type = 'agent' AND caller_kind IS DISTINCT FROM 'agent' THEN
      RAISE EXCEPTION 'record_audit: agent entries require an agent identity'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF actor_type = 'user' AND caller_kind = 'agent' THEN
      RAISE EXCEPTION 'record_audit: an agent identity records agent entries, not user entries'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policies p WHERE p.id = policy_id AND p.workspace_id = record_audit.workspace_id
  ) THEN
    RAISE EXCEPTION 'record_audit: policy % does not belong to workspace %', policy_id, record_audit.workspace_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF approval_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.approvals a WHERE a.id = approval_id AND a.workspace_id = record_audit.workspace_id
  ) THEN
    RAISE EXCEPTION 'record_audit: approval % does not belong to workspace %', approval_id, record_audit.workspace_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO public.audit_log AS l (workspace_id, actor_type, actor_id, action, target, decision, policy_id, approval_id, details)
  VALUES (
    record_audit.workspace_id,
    record_audit.actor_type,
    CASE WHEN record_audit.actor_type = 'system' THEN NULL ELSE caller END,
    record_audit.action,
    record_audit.target,
    record_audit.decision,
    record_audit.policy_id,
    record_audit.approval_id,
    coalesce(record_audit.details, '{}'::jsonb)
  )
  RETURNING l.id INTO entry_id;
  RETURN entry_id;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_run_usage(
  run_id uuid,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  cost_micro_usd bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_workspace uuid;
  updated jsonb;
BEGIN
  IF coalesce(input_tokens, -1) < 0 OR coalesce(output_tokens, -1) < 0
    OR coalesce(cache_read_tokens, -1) < 0 OR coalesce(cache_write_tokens, -1) < 0
    OR coalesce(cost_micro_usd, -1) < 0 THEN
    RAISE EXCEPTION 'add_run_usage: usage must be non-negative' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.workspace_id INTO target_workspace FROM public.runs r WHERE r.id = add_run_usage.run_id;
  IF target_workspace IS NULL
    OR coalesce(public.app_workspace_role(target_workspace), '') NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'add_run_usage: run not found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE public.runs r
  SET totals = jsonb_build_object(
    'inputTokens', (r.totals ->> 'inputTokens')::bigint + input_tokens,
    'outputTokens', (r.totals ->> 'outputTokens')::bigint + output_tokens,
    'cacheReadTokens', (r.totals ->> 'cacheReadTokens')::bigint + cache_read_tokens,
    'cacheWriteTokens', (r.totals ->> 'cacheWriteTokens')::bigint + cache_write_tokens,
    'costMicroUsd', (r.totals ->> 'costMicroUsd')::bigint + cost_micro_usd
  )
  WHERE r.id = add_run_usage.run_id
  RETURNING r.totals INTO updated;
  RETURN updated;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION visible_user_email(user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF caller IS NULL OR visible_user_email.user_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT u.email
    FROM public.users u
    WHERE u.id = visible_user_email.user_id
      AND (
        u.id = caller
        OR EXISTS (
          SELECT 1
          FROM public.members mine
          JOIN public.members theirs ON theirs.workspace_id = mine.workspace_id
          WHERE mine.user_id = caller
            AND mine.role IN ('owner', 'admin')
            AND theirs.user_id = u.id
        )
      )
  );
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purge_expired_demo_runs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  doomed uuid[];
  purged integer;
BEGIN
  WITH RECURSIVE expired AS (
    SELECT r.id
    FROM public.runs r
    JOIN public.workspaces w ON w.id = r.workspace_id
    WHERE w.is_demo AND r.created_at < now() - make_interval(days => w.retention_days)
    UNION
    SELECT child.id FROM public.runs child JOIN expired e ON child.parent_run_id = e.id
  )
  SELECT coalesce(array_agg(id), '{}') INTO doomed FROM expired;
  PERFORM set_config('delegate.retention_purge', 'on', true);
  DELETE FROM public.audit_log l
  USING public.workspaces w
  WHERE w.id = l.workspace_id
    AND w.is_demo
    AND (
      l.created_at < now() - make_interval(days => w.retention_days)
      OR l.approval_id IN (SELECT a.id FROM public.approvals a WHERE a.run_id = ANY (doomed))
    );
  DELETE FROM public.runs r WHERE r.id = ANY (doomed);
  GET DIAGNOSTICS purged = ROW_COUNT;
  PERFORM set_config('delegate.retention_purge', '', true);
  RETURN purged;
END
$$;
--> statement-breakpoint
ALTER FUNCTION resolve_approval(uuid, text) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION record_audit(uuid, text, text, public.audit_decision, uuid, uuid, jsonb, public.audit_actor_type) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION add_run_usage(uuid, bigint, bigint, bigint, bigint, bigint) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION visible_user_email(uuid) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION purge_expired_demo_runs() OWNER TO delegate_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  app_keep_workspace_owner(),
  resolve_approval(uuid, text),
  record_audit(uuid, text, text, public.audit_decision, uuid, uuid, jsonb, public.audit_actor_type),
  add_run_usage(uuid, bigint, bigint, bigint, bigint, bigint),
  visible_user_email(uuid),
  purge_expired_demo_runs()
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  resolve_approval(uuid, text),
  record_audit(uuid, text, text, public.audit_decision, uuid, uuid, jsonb, public.audit_actor_type),
  add_run_usage(uuid, bigint, bigint, bigint, bigint, bigint),
  visible_user_email(uuid)
TO delegate_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_demo_runs() TO delegate_maintenance;
