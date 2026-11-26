ALTER TABLE "workspace_settings" ADD COLUMN "runs_paused_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "run_events_workspace_type_created_idx" ON "run_events" USING btree ("workspace_id","type","created_at");--> statement-breakpoint
CREATE POLICY "policies_definer_delete" ON "policies" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "assistants_definer_select" ON "assistants" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "assistants_definer_delete" ON "assistants" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "documents_definer_select" ON "documents" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "documents_definer_delete" ON "documents" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "memories_definer_select" ON "memories" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "memories_definer_delete" ON "memories" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "artifacts_definer_select" ON "artifacts" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "run_events_definer_select" ON "run_events" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "api_tokens_definer_delete" ON "api_tokens" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "github_installations_definer_select" ON "github_installations" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "github_installations_definer_delete" ON "github_installations" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "mcp_connectors_definer_select" ON "mcp_connectors" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "mcp_connectors_definer_delete" ON "mcp_connectors" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "workspace_settings_definer_select" ON "workspace_settings" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "workspace_settings_definer_delete" ON "workspace_settings" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_endpoints_definer_delete" ON "webhook_endpoints" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "playbooks_definer_delete" ON "playbooks" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING ("playbooks"."workspace_id" is not null);--> statement-breakpoint
GRANT SELECT ON TABLE run_events, artifacts TO delegate_definer;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE assistants, documents, memories, mcp_connectors, github_installations, workspace_settings TO delegate_definer;
--> statement-breakpoint
GRANT DELETE ON TABLE policies, playbooks, api_tokens, webhook_endpoints TO delegate_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_reject_run_while_paused()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.workspace_settings s
    WHERE s.workspace_id = NEW.workspace_id AND s.runs_paused_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'runs: new runs are paused for workspace %', NEW.workspace_id
      USING ERRCODE = 'DG001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  call_stack text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    GET DIAGNOSTICS call_stack = PG_CONTEXT;
    IF current_setting('delegate.retention_purge', true) = 'on'
      AND call_stack LIKE '%PL/pgSQL function purge_expired_demo_runs() %' THEN
      RETURN OLD;
    END IF;
    IF current_setting('delegate.workspace_erasure', true) = 'on'
      AND call_stack LIKE '%PL/pgSQL function delete_workspace_data(uuid) %' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_workspace_data(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  caller_role text;
  caller_kind public.user_kind;
  counts jsonb;
  receipt bigint;
BEGIN
  caller_role := CASE WHEN p_workspace_id IS NULL THEN NULL ELSE public.app_workspace_role(p_workspace_id) END;
  IF caller IS NULL OR caller_role IS NULL THEN
    RAISE EXCEPTION 'delete_workspace_data: workspace not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF caller_role <> 'owner' THEN
    RAISE EXCEPTION 'delete_workspace_data: requires the workspace owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT u.kind INTO caller_kind FROM public.users u WHERE u.id = caller;
  IF caller_kind IS DISTINCT FROM 'member' AND caller_kind IS DISTINCT FROM 'guest' THEN
    RAISE EXCEPTION 'delete_workspace_data: agents cannot delete workspace data' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('delegate.workspace_erasure:' || p_workspace_id::text, 0));
  counts := jsonb_build_object(
    'runs', (SELECT count(*) FROM public.runs r WHERE r.workspace_id = p_workspace_id),
    'events', (SELECT count(*) FROM public.run_events e WHERE e.workspace_id = p_workspace_id),
    'artifacts', (SELECT count(*) FROM public.artifacts a WHERE a.workspace_id = p_workspace_id),
    'approvals', (SELECT count(*) FROM public.approvals a WHERE a.workspace_id = p_workspace_id),
    'assistants', (SELECT count(*) FROM public.assistants a WHERE a.workspace_id = p_workspace_id),
    'documents', (SELECT count(*) FROM public.documents d WHERE d.workspace_id = p_workspace_id),
    'memories', (SELECT count(*) FROM public.memories m WHERE m.workspace_id = p_workspace_id),
    'playbooks', (SELECT count(*) FROM public.playbooks p WHERE p.workspace_id = p_workspace_id),
    'policies', (SELECT count(*) FROM public.policies p WHERE p.workspace_id = p_workspace_id),
    'connectors', (SELECT count(*) FROM public.mcp_connectors c WHERE c.workspace_id = p_workspace_id),
    'githubInstallations', (SELECT count(*) FROM public.github_installations g WHERE g.workspace_id = p_workspace_id),
    'apiTokens', (SELECT count(*) FROM public.api_tokens t WHERE t.workspace_id = p_workspace_id),
    'webhookEndpoints', (SELECT count(*) FROM public.webhook_endpoints w WHERE w.workspace_id = p_workspace_id),
    'webhookDeliveries', (SELECT count(*) FROM public.webhook_deliveries w WHERE w.workspace_id = p_workspace_id),
    'idempotencyKeys', (SELECT count(*) FROM public.idempotency_keys k WHERE k.workspace_id = p_workspace_id),
    'settings', (SELECT count(*) FROM public.workspace_settings s WHERE s.workspace_id = p_workspace_id),
    'auditEntries', (
      SELECT count(*) FROM public.audit_log l
      WHERE l.workspace_id = p_workspace_id AND l.action <> 'workspace.data_deleted'
    )
  );
  INSERT INTO public.audit_log AS l (workspace_id, actor_type, actor_id, action, target, decision, details)
  VALUES (
    p_workspace_id, 'user', caller, 'workspace.data_deleted', 'workspace:' || p_workspace_id::text,
    'n/a', jsonb_build_object('counts', counts)
  )
  RETURNING l.id INTO receipt;
  PERFORM set_config('delegate.workspace_erasure', 'on', true);
  DELETE FROM public.audit_log l
  WHERE l.workspace_id = p_workspace_id AND l.action <> 'workspace.data_deleted';
  DELETE FROM public.runs r WHERE r.workspace_id = p_workspace_id;
  DELETE FROM public.assistants a WHERE a.workspace_id = p_workspace_id;
  DELETE FROM public.documents d WHERE d.workspace_id = p_workspace_id;
  DELETE FROM public.memories m WHERE m.workspace_id = p_workspace_id;
  DELETE FROM public.playbooks p WHERE p.workspace_id = p_workspace_id;
  DELETE FROM public.policies p WHERE p.workspace_id = p_workspace_id;
  DELETE FROM public.mcp_connectors c WHERE c.workspace_id = p_workspace_id;
  DELETE FROM public.github_installations g WHERE g.workspace_id = p_workspace_id;
  DELETE FROM public.webhook_deliveries w WHERE w.workspace_id = p_workspace_id;
  DELETE FROM public.webhook_endpoints w WHERE w.workspace_id = p_workspace_id;
  DELETE FROM public.idempotency_keys k WHERE k.workspace_id = p_workspace_id;
  DELETE FROM public.api_tokens t WHERE t.workspace_id = p_workspace_id;
  DELETE FROM public.workspace_settings s WHERE s.workspace_id = p_workspace_id;
  PERFORM set_config('delegate.workspace_erasure', '', true);
  RETURN jsonb_build_object('receipt', receipt, 'counts', counts);
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION app_reject_run_while_paused() OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION delete_workspace_data(uuid) OWNER TO delegate_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM delegate_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_reject_run_while_paused(), delete_workspace_data(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_workspace_data(uuid) TO delegate_app;
--> statement-breakpoint
CREATE TRIGGER runs_reject_while_paused
BEFORE INSERT ON runs
FOR EACH ROW EXECUTE FUNCTION app_reject_run_while_paused();