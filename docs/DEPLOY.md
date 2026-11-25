# Deploy (Vercel + Neon, both free tiers)

1. **Neon**: create a project (region: AWS US East, to sit next to Vercel's `iad1`). On the dashboard, open **Connect**, turn **Connection pooling off**, copy the connection string. It logs in as the owner.
2. In this repo, run `sh scripts/neon-setup.sh` and paste that string at the hidden prompt. It runs every migration, sets a random password on `delegate_app_login`, checks that role cannot bypass row-level security, and prints `DATABASE_URL` (pooled, app login) and `DELEGATE_SESSION_SECRET`. Nothing is written to disk.
3. **Vercel**: *Add New → Project*, import `delegate`, set **Root Directory** to `apps/web`, keep the detected Next.js and pnpm settings.
4. Add environment variables (Production): `DATABASE_URL`, `DELEGATE_SESSION_SECRET` from step 2, and `NVIDIA_API_KEY`. Deploy.

The owner connection string is only used in step 2; the app never sees it. Prompt files and `pnpm-workspace.yaml` are traced into the function bundle by `outputFileTracingIncludes` in `apps/web/next.config.ts`.

Limits on the free tier: a function runs at most 300 s. Longer missions are checkpointed in `run_events`; when the lease expires, the next visit to the run page resumes it from the last finished step (ADR 0007).
