ALTER TABLE "github_installations" ADD COLUMN "repositories_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "github_user_id" bigint;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "github_login" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_login_format" CHECK ("github_installations"."github_login" is null or "github_installations"."github_login" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$');