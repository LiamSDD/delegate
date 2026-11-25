CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "api_tokens_name_length" CHECK (char_length("api_tokens"."name") between 1 and 80),
	CONSTRAINT "api_tokens_prefix_format" CHECK ("api_tokens"."prefix" ~ '^dlg_[A-Za-z0-9_-]{8}$'),
	CONSTRAINT "api_tokens_hash_format" CHECK ("api_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connected_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_workspace_installation_unique" UNIQUE("workspace_id","installation_id"),
	CONSTRAINT "github_installations_selection_known" CHECK ("github_installations"."repository_selection" in ('all', 'selected')),
	CONSTRAINT "github_installations_id_positive" CHECK ("github_installations"."installation_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "github_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_header_name" text,
	"secret_ciphertext" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connectors_workspace_name_unique" UNIQUE("workspace_id","name"),
	CONSTRAINT "mcp_connectors_name_format" CHECK ("mcp_connectors"."name" ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
	CONSTRAINT "mcp_connectors_secret_needs_header" CHECK ("mcp_connectors"."secret_ciphertext" is null or "mcp_connectors"."auth_header_name" is not null)
);
--> statement-breakpoint
ALTER TABLE "mcp_connectors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"auto_approve_plans" boolean DEFAULT false NOT NULL,
	"preapproved_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_settings_preapproved_is_array" CHECK (jsonb_typeof("workspace_settings"."preapproved_tools") = 'array')
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_events" DROP CONSTRAINT "run_events_type_known";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connectors" ADD CONSTRAINT "mcp_connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connectors" ADD CONSTRAINT "mcp_connectors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_workspace_idx" ON "api_tokens" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_type_known" CHECK ("run_events"."type" in ('run.created', 'plan.proposed', 'plan.approved', 'plan.revised', 'step.started', 'agent.spawned', 'agent.message', 'tool.called', 'tool.result', 'policy.decided', 'artifact.created', 'artifact.updated', 'critic.flagged', 'approval.requested', 'approval.resolved', 'usage.updated', 'step.completed', 'run.completed', 'run.failed', 'model.fallback', 'connector.call'));--> statement-breakpoint
CREATE POLICY "api_tokens_select" ON "api_tokens" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("api_tokens"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "api_tokens_insert" ON "api_tokens" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("api_tokens"."workspace_id") in ('owner', 'admin') and "api_tokens"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "api_tokens_update" ON "api_tokens" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("api_tokens"."workspace_id") in ('owner', 'admin')) WITH CHECK (app_workspace_role("api_tokens"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "api_tokens_definer_select" ON "api_tokens" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "api_tokens_definer_update" ON "api_tokens" AS PERMISSIVE FOR UPDATE TO "delegate_definer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "github_installations_select" ON "github_installations" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("github_installations"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "github_installations_insert" ON "github_installations" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("github_installations"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "github_installations_update" ON "github_installations" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("github_installations"."workspace_id") in ('owner', 'admin')) WITH CHECK (app_workspace_role("github_installations"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "github_installations_delete" ON "github_installations" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("github_installations"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "mcp_connectors_select" ON "mcp_connectors" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("mcp_connectors"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "mcp_connectors_insert" ON "mcp_connectors" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("mcp_connectors"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "mcp_connectors_update" ON "mcp_connectors" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("mcp_connectors"."workspace_id") in ('owner', 'admin')) WITH CHECK (app_workspace_role("mcp_connectors"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "mcp_connectors_delete" ON "mcp_connectors" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("mcp_connectors"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "workspace_settings_select" ON "workspace_settings" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("workspace_settings"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "workspace_settings_insert" ON "workspace_settings" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("workspace_settings"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "workspace_settings_update" ON "workspace_settings" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("workspace_settings"."workspace_id") in ('owner', 'admin')) WITH CHECK (app_workspace_role("workspace_settings"."workspace_id") in ('owner', 'admin'));
--> statement-breakpoint
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mcp_connectors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT (id, workspace_id, created_by, name, prefix, created_at, last_used_at, revoked_at) ON TABLE api_tokens TO delegate_app;
--> statement-breakpoint
GRANT INSERT ON TABLE api_tokens TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON TABLE api_tokens TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mcp_connectors, github_installations TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE workspace_settings TO delegate_app;
--> statement-breakpoint
GRANT SELECT ON TABLE api_tokens TO delegate_definer;
--> statement-breakpoint
GRANT UPDATE (last_used_at) ON TABLE api_tokens TO delegate_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_keep_api_token_revoked()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'api token % is revoked and cannot be restored', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER api_tokens_keep_revoked
BEFORE UPDATE ON api_tokens
FOR EACH ROW EXECUTE FUNCTION app_keep_api_token_revoked();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_api_token(p_prefix text, p_hash text)
RETURNS TABLE (token_id uuid, workspace_id uuid, user_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  hit public.api_tokens%ROWTYPE;
BEGIN
  SELECT * INTO hit FROM public.api_tokens t
  WHERE t.prefix = p_prefix AND t.token_hash = p_hash AND t.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.workspace_id = hit.workspace_id
      AND m.user_id = hit.created_by
      AND m.role IN ('owner', 'admin', 'operator')
  ) THEN
    RETURN;
  END IF;
  IF hit.last_used_at IS NULL OR hit.last_used_at < now() - interval '1 minute' THEN
    UPDATE public.api_tokens SET last_used_at = now() WHERE id = hit.id;
  END IF;
  token_id := hit.id;
  workspace_id := hit.workspace_id;
  user_id := hit.created_by;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION resolve_api_token(text, text) OWNER TO delegate_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM delegate_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_api_token(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_api_token(text, text) TO delegate_app;