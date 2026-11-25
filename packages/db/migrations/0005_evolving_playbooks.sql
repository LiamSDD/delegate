CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbooks_workspace_key_version_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","key","version"),
	CONSTRAINT "playbooks_scope_known" CHECK ("playbooks"."scope" in ('workspace', 'house')),
	CONSTRAINT "playbooks_house_has_no_workspace" CHECK (("playbooks"."scope" = 'house') = ("playbooks"."workspace_id" is null)),
	CONSTRAINT "playbooks_version_positive" CHECK ("playbooks"."version" > 0),
	CONSTRAINT "playbooks_runs_nonnegative" CHECK ("playbooks"."runs" >= 0)
);
--> statement-breakpoint
ALTER TABLE "playbooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_events" DROP CONSTRAINT "run_events_type_known";--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbooks_lookup_idx" ON "playbooks" USING btree ("workspace_id","key","version");--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_type_known" CHECK ("run_events"."type" in ('run.created', 'plan.proposed', 'plan.approved', 'plan.revised', 'step.started', 'agent.spawned', 'agent.message', 'tool.called', 'tool.result', 'policy.decided', 'artifact.created', 'artifact.updated', 'critic.flagged', 'approval.requested', 'approval.resolved', 'usage.updated', 'step.completed', 'run.completed', 'run.failed', 'model.fallback', 'playbook.applied'));--> statement-breakpoint
CREATE POLICY "playbooks_select" ON "playbooks" AS PERMISSIVE FOR SELECT TO "delegate_app" USING ("playbooks"."workspace_id" is null or app_workspace_role("playbooks"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "playbooks_insert" ON "playbooks" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK ("playbooks"."workspace_id" is not null and "playbooks"."scope" = 'workspace' and app_workspace_role("playbooks"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "playbooks_definer_select" ON "playbooks" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "playbooks_definer_insert" ON "playbooks" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
ALTER TABLE playbooks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE playbooks TO delegate_app;
--> statement-breakpoint
GRANT SELECT, INSERT (workspace_id, scope, key, version, runs, content) ON TABLE playbooks TO delegate_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_house_playbook(
  p_workspace_id uuid,
  p_key text,
  p_version integer,
  p_runs integer,
  p_content jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_role text;
  latest integer;
BEGIN
  caller_role := public.app_workspace_role(p_workspace_id)::text;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'only an owner or admin of a workspace may record the house playbook'
      USING ERRCODE = '42501';
  END IF;
  IF (SELECT w.is_demo FROM public.workspaces w WHERE w.id = p_workspace_id) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'demo workspaces never feed the house playbook' USING ERRCODE = '42501';
  END IF;
  IF p_content->>'scope' IS DISTINCT FROM 'house' OR p_content->>'key' IS DISTINCT FROM p_key THEN
    RAISE EXCEPTION 'house playbook content does not match its key' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(max(p.version), 0) INTO latest
  FROM public.playbooks p
  WHERE p.workspace_id IS NULL AND p.key = p_key;
  IF p_version <> latest + 1 THEN
    RAISE EXCEPTION 'house playbook % is at version %, not %', p_key, latest, p_version - 1
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.playbooks (workspace_id, scope, key, version, runs, content)
  VALUES (NULL, 'house', p_key, p_version, p_runs, p_content);
  RETURN p_version;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION record_house_playbook(uuid, text, integer, integer, jsonb) OWNER TO delegate_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM delegate_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_house_playbook(uuid, text, integer, integer, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_house_playbook(uuid, text, integer, integer, jsonb) TO delegate_app;