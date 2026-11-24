CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_decision" AS ENUM('allow', 'deny', 'require_approval', 'n/a');--> statement-breakpoint
CREATE TYPE "public"."document_classification" AS ENUM('public', 'internal', 'confidential', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'operator', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('planning', 'awaiting_plan_approval', 'running', 'awaiting_approval', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_kind" AS ENUM('member', 'guest', 'agent');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"decision" "audit_decision" NOT NULL,
	"policy_id" uuid,
	"approval_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_identified" CHECK ("audit_log"."actor_type" = 'system' or "audit_log"."actor_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_workspace_name_version_unique" UNIQUE("workspace_id","name","version"),
	CONSTRAINT "policies_version_positive" CHECK ("policies"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_document_ordinal_unique" UNIQUE("document_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_url" text,
	"title" text NOT NULL,
	"content_hash" text NOT NULL,
	"classification" "document_classification" DEFAULT 'internal' NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_id_workspace_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_by_agent" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_scope_key_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","run_id","key")
);
--> statement-breakpoint
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"action" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "approvals_resolution_consistent" CHECK (("approvals"."status" = 'pending') = ("approvals"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_version_positive" CHECK ("artifacts"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"step_id" text,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_seq_unique" UNIQUE("run_id","seq"),
	CONSTRAINT "run_events_seq_positive" CHECK ("run_events"."seq" > 0),
	CONSTRAINT "run_events_type_known" CHECK ("run_events"."type" in ('run.created', 'plan.proposed', 'plan.approved', 'plan.revised', 'step.started', 'agent.spawned', 'agent.message', 'tool.called', 'tool.result', 'policy.decided', 'artifact.created', 'artifact.updated', 'critic.flagged', 'approval.requested', 'approval.resolved', 'usage.updated', 'step.completed', 'run.completed', 'run.failed', 'model.fallback'))
);
--> statement-breakpoint
ALTER TABLE "run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mission" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" "run_status" DEFAULT 'planning' NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"parent_run_id" uuid,
	"forked_from_seq" integer,
	"prompt_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"totals" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costMicroUsd":0}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "runs_forked_from_seq_needs_parent" CHECK ("runs"."forked_from_seq" is null or ("runs"."parent_run_id" is not null and "runs"."forked_from_seq" >= 0))
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_workspace_user_unique" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "orgs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"kind" "user_kind" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"retention_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_org_slug_unique" UNIQUE("org_id","slug"),
	CONSTRAINT "workspaces_retention_days_positive" CHECK ("workspaces"."retention_days" is null or "workspaces"."retention_days" > 0),
	CONSTRAINT "workspaces_demo_retention_max_7_days" CHECK (not "workspaces"."is_demo" or ("workspaces"."retention_days" is not null and "workspaces"."retention_days" <= 7))
);
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_fk" FOREIGN KEY ("document_id","workspace_id") REFERENCES "public"."documents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_fk" FOREIGN KEY ("parent_run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_workspace_created_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "documents_workspace_hash_idx" ON "documents" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "approvals_run_idx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approvals_workspace_status_idx" ON "approvals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_workspace_created_idx" ON "runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "members_user_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "audit_log_select" ON "audit_log" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("audit_log"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "audit_log_definer_select" ON "audit_log" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "audit_log_definer_insert" ON "audit_log" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "audit_log_definer_delete" ON "audit_log" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "policies_select" ON "policies" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("policies"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "policies_insert" ON "policies" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("policies"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "policies_update" ON "policies" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("policies"."workspace_id") in ('owner', 'admin')) WITH CHECK (app_workspace_role("policies"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "policies_delete" ON "policies" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("policies"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "policies_definer_select" ON "policies" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "chunks_select" ON "chunks" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("chunks"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "chunks_insert" ON "chunks" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("chunks"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "chunks_update" ON "chunks" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("chunks"."workspace_id") in ('owner', 'admin', 'operator')) WITH CHECK (app_workspace_role("chunks"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "chunks_delete" ON "chunks" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("chunks"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "documents_select" ON "documents" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("documents"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "documents_insert" ON "documents" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("documents"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "documents_update" ON "documents" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("documents"."workspace_id") in ('owner', 'admin', 'operator')) WITH CHECK (app_workspace_role("documents"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "documents_delete" ON "documents" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("documents"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "memories_select" ON "memories" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("memories"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "memories_insert" ON "memories" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("memories"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "memories_update" ON "memories" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("memories"."workspace_id") in ('owner', 'admin', 'operator')) WITH CHECK (app_workspace_role("memories"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "memories_delete" ON "memories" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("memories"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "approvals_select" ON "approvals" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("approvals"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "approvals_insert" ON "approvals" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("approvals"."workspace_id") in ('owner', 'admin', 'operator') and "approvals"."status" = 'pending' and "approvals"."resolved_at" is null and "approvals"."resolved_by" is null);--> statement-breakpoint
CREATE POLICY "approvals_definer_select" ON "approvals" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "approvals_definer_update" ON "approvals" AS PERMISSIVE FOR UPDATE TO "delegate_definer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "artifacts_select" ON "artifacts" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("artifacts"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "artifacts_insert" ON "artifacts" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("artifacts"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "artifacts_update" ON "artifacts" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("artifacts"."workspace_id") in ('owner', 'admin', 'operator')) WITH CHECK (app_workspace_role("artifacts"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "run_events_select" ON "run_events" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("run_events"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "run_events_insert" ON "run_events" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("run_events"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "runs_select" ON "runs" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("runs"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "runs_insert" ON "runs" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("runs"."workspace_id") in ('owner', 'admin', 'operator') and "runs"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid and "runs"."totals" = '{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costMicroUsd":0}'::jsonb);--> statement-breakpoint
CREATE POLICY "runs_update" ON "runs" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("runs"."workspace_id") in ('owner', 'admin', 'operator')) WITH CHECK (app_workspace_role("runs"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "runs_definer_select" ON "runs" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "runs_definer_update" ON "runs" AS PERMISSIVE FOR UPDATE TO "delegate_definer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "runs_definer_delete" ON "runs" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "members_select" ON "members" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("members"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "members_insert" ON "members" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("members"."workspace_id") in ('owner', 'admin') and ("members"."role" <> 'owner' or app_workspace_role("members"."workspace_id") = 'owner'));--> statement-breakpoint
CREATE POLICY "members_update" ON "members" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("members"."workspace_id") in ('owner', 'admin') and ("members"."role" <> 'owner' or app_workspace_role("members"."workspace_id") = 'owner')) WITH CHECK (app_workspace_role("members"."workspace_id") in ('owner', 'admin') and ("members"."role" <> 'owner' or app_workspace_role("members"."workspace_id") = 'owner'));--> statement-breakpoint
CREATE POLICY "members_delete" ON "members" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("members"."workspace_id") in ('owner', 'admin') and ("members"."role" <> 'owner' or app_workspace_role("members"."workspace_id") = 'owner'));--> statement-breakpoint
CREATE POLICY "members_definer_select" ON "members" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "orgs_select" ON "orgs" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_is_org_member("orgs"."id"));--> statement-breakpoint
CREATE POLICY "users_select" ON "users" AS PERMISSIVE FOR SELECT TO "delegate_app" USING ("users"."id" = nullif(current_setting('app.user_id', true), '')::uuid or app_shares_workspace("users"."id"));--> statement-breakpoint
CREATE POLICY "users_update_self" ON "users" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING ("users"."id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("users"."id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "users_definer_select" ON "users" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "workspaces_select" ON "workspaces" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("workspaces"."id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "workspaces_update" ON "workspaces" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("workspaces"."id") in ('owner', 'admin')) WITH CHECK (app_workspace_role("workspaces"."id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "workspaces_definer_select" ON "workspaces" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);