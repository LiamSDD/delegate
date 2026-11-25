# Deploy (Vercel + Neon, both free tiers)

1. **Neon**: create a project (region: AWS US East, to sit next to Vercel's `iad1`). On the dashboard, open **Connect**, turn **Connection pooling off**, copy the connection string. It logs in as the owner.
2. In this repo, run `sh scripts/neon-setup.sh` and paste that string at the hidden prompt. It runs every migration, sets a random password on `delegate_app_login`, checks that role cannot bypass row-level security, and writes `DATABASE_URL` (pooled, app login), `DELEGATE_SESSION_SECRET` and `NVIDIA_API_KEY` to `.env.vercel.local` (gitignored, mode 600), then opens it. In Vercel, paste the whole file into the first environment variable field; Vercel splits it into three.
3. **Vercel**: *Add New → Project*, import `delegate`, set **Root Directory** to `apps/web`, keep the detected Next.js and pnpm settings.
4. Add environment variables (Production): `DATABASE_URL`, `DELEGATE_SESSION_SECRET` from step 2, and `NVIDIA_API_KEY`. Deploy.

The owner connection string is only used in step 2; the app never sees it. Prompt files and `pnpm-workspace.yaml` are traced into the function bundle by `outputFileTracingIncludes` in `apps/web/next.config.ts`.

Limits on the free tier: a function runs at most 300 s. Longer missions are checkpointed in `run_events`; when the lease expires, the next visit to the run page resumes it from the last finished step (ADR 0007).

## Platform connections (optional)

These turn on `/settings/connections` features (ADR 0014). Add them in Vercel → Project → Settings → Environment Variables (Production), then redeploy.

| Variable | What it enables | How to get it |
|---|---|---|
| `DELEGATE_ENCRYPTION_KEY` | Storing MCP connector secrets (bearer tokens, API-key headers), AES-256-GCM at rest | `openssl rand -hex 32` (64 hex characters). Keep it stable: rotating it makes stored connector secrets unreadable, and those connectors must be re-added. |
| `GITHUB_APP_CLIENT_ID` | "Connect GitHub" | GitHub → Settings → Developer settings → GitHub Apps → your app → *Client ID* |
| `GITHUB_APP_CLIENT_SECRET` | "Connect GitHub" | Same page → *Generate a new client secret* |
| `GITHUB_APP_SLUG` | The "Install on repositories" link | The last part of `https://github.com/apps/<slug>` |

GitHub App settings for the connect flow:

- **Callback URL:** `https://<host>/api/github/callback` (add the preview host too if you test previews).
- **Setup URL (optional):** `https://<host>/api/github/setup`, with **Redirect on update** checked, so changing the repository selection on GitHub re-syncs it in Delegate.
- **Request user authorization (OAuth) during installation:** either setting works. If on, GitHub returns to the callback with the installation; if off, the setup URL sends the user through authorization once, so Delegate can verify the installation with `GET /user/installations`.
- **Webhook:** not needed for connecting. Installation tokens and pull requests belong to Ship-a-PR, which uses the same App.

Delegate never stores the GitHub user access token; it only uses it during the callback request.

The MCP endpoint (`/api/mcp`) needs no extra variables: it is stateless Streamable HTTP, so it works on serverless functions, and `wait_for_run` long-polls for at most 120 s, inside the 300 s function limit.
