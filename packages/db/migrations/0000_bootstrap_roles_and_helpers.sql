CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'delegate_app') THEN
    CREATE ROLE delegate_app NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT delegate_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO delegate_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_workspace_role(target_workspace uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN (
    SELECT m.role::text
    FROM public.members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_org_member(target_org uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    WHERE w.org_id = target_org
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_shares_workspace(target_user uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.members mine
    JOIN public.members theirs ON theirs.workspace_id = mine.workspace_id
    WHERE mine.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND theirs.user_id = target_user
  );
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_workspace_role(uuid), app_is_org_member(uuid), app_shares_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_workspace_role(uuid), app_is_org_member(uuid), app_shares_workspace(uuid) TO delegate_app;
