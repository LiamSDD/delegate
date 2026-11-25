CREATE TABLE "assistants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid,
	"name" text NOT NULL,
	"collection" text NOT NULL,
	"config" jsonb NOT NULL,
	"evals" jsonb,
	"gaps" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "heading" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "collection" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistants_workspace_idx" ON "assistants" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_collection_url_unique" UNIQUE("workspace_id","collection","source_url");--> statement-breakpoint
CREATE POLICY "assistants_select" ON "assistants" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("assistants"."workspace_id") in ('owner', 'admin', 'operator', 'viewer'));--> statement-breakpoint
CREATE POLICY "assistants_insert" ON "assistants" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("assistants"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "assistants_update" ON "assistants" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("assistants"."workspace_id") in ('owner', 'admin', 'operator')) WITH CHECK (app_workspace_role("assistants"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
CREATE POLICY "assistants_delete" ON "assistants" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("assistants"."workspace_id") in ('owner', 'admin', 'operator'));--> statement-breakpoint
ALTER TABLE assistants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE assistants TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (lease_owner, lease_expires_at) ON TABLE runs TO delegate_app;
