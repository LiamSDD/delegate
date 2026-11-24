CREATE POLICY "members_definer_insert" ON "members" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "orgs_definer_select" ON "orgs" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "orgs_definer_insert" ON "orgs" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "users_definer_insert" ON "users" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "workspaces_definer_insert" ON "workspaces" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
GRANT INSERT (display_name, kind) ON TABLE users TO delegate_definer;
--> statement-breakpoint
GRANT SELECT, INSERT (name, slug) ON TABLE orgs TO delegate_definer;
--> statement-breakpoint
GRANT INSERT (org_id, name, slug, is_demo, retention_days) ON TABLE workspaces TO delegate_definer;
--> statement-breakpoint
GRANT INSERT (workspace_id, user_id, role) ON TABLE members TO delegate_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_guest_workspace()
RETURNS TABLE (user_id uuid, workspace_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_user uuid;
  new_org uuid;
  new_workspace uuid;
BEGIN
  INSERT INTO public.users (display_name, kind) VALUES ('Guest', 'guest') RETURNING id INTO new_user;
  INSERT INTO public.orgs (name, slug)
  VALUES ('Guest', 'guest-' || replace(gen_random_uuid()::text, '-', ''))
  RETURNING id INTO new_org;
  INSERT INTO public.workspaces (org_id, name, slug, is_demo, retention_days)
  VALUES (new_org, 'Demo workspace', 'demo', true, 7)
  RETURNING id INTO new_workspace;
  INSERT INTO public.members (workspace_id, user_id, role) VALUES (new_workspace, new_user, 'owner');
  user_id := new_user;
  workspace_id := new_workspace;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION create_guest_workspace() OWNER TO delegate_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_guest_workspace() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_guest_workspace() TO delegate_app;
