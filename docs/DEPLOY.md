# Deploy (Vercel + Neon, both free tiers)

1. **Neon**: create a project (region: AWS US East, to sit next to Vercel's `iad1`). On the dashboard, open **Connect**, turn **Connection pooling off**, copy the connection string. It logs in as the owner.
2. In this repo, run `sh scripts/neon-setup.sh` and paste that string at the hidden prompt. It runs every migration, sets a random password on `delegate_app_login`, checks that role cannot bypass row-level security, and writes `DATABASE_URL` (pooled, app login), `DELEGATE_SESSION_SECRET` and `NVIDIA_API_KEY` to `.env.vercel.local` (gitignored, mode 600), then opens it. In Vercel, paste the whole file into the first environment variable field; Vercel splits it into three.
3. **Vercel**: *Add New → Project*, import `delegate`, set **Root Directory** to `apps/web`, keep the detected Next.js and pnpm settings.
4. Add environment variables (Production): `DATABASE_URL`, `DELEGATE_SESSION_SECRET` from step 2, and `NVIDIA_API_KEY`. Deploy.

The owner connection string is only used in step 2; the app never sees it. Prompt files and `pnpm-workspace.yaml` are traced into the function bundle by `outputFileTracingIncludes` in `apps/web/next.config.ts`.

Limits on the free tier: a function runs at most 300 s. Longer missions are checkpointed in `run_events`; when the lease expires, the next visit to the run page resumes it from the last finished step (ADR 0007).

## Ship-a-PR: Vercel Sandbox and the GitHub App

Ship-a-PR (ADR 0011) runs the Engineer in a Vercel Sandbox and opens pull requests through a GitHub App you own. Both are free; neither is needed for the other missions.

### Turn it on

1. In Vercel → *Project → Settings → Environment Variables* (Production), add `DELEGATE_SHIP_A_PR` = `1`. Without it `/api/ship` answers 503 and no sandbox time is spent.
2. Vercel Sandbox needs no key on Vercel: the function authenticates with its OIDC token. `DELEGATE_SANDBOX` defaults to `vercel` in production; leave it unset. Hobby includes 5 CPU-hours a month and sessions of at most 45 minutes; over the quota, sandboxes pause rather than bill. Each run uses a 2 vCPU sandbox for a few minutes.
3. Locally, `DELEGATE_SANDBOX=local` (the default outside production) runs commands in a temporary directory with a scrubbed environment. It is not an isolation boundary: use it only on repositories you trust. To use Vercel Sandbox from your machine, run `vercel link` and `vercel env pull` (writes a 12-hour `VERCEL_OIDC_TOKEN` to `.env.local`) and set `DELEGATE_SANDBOX=vercel`.

### Create the GitHub App (click by click)

1. GitHub → your avatar → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. **GitHub App name**: for example `delegate-ship-<you>`. The URL slug GitHub shows under the name is your `GITHUB_APP_SLUG`.
3. **Homepage URL**: your Vercel URL. Leave **Callback URL** empty unless you also use Connect GitHub.
4. **Webhook**: untick **Active**. Delegate never needs events.
5. **Repository permissions**: **Contents** → *Read and write*; **Pull requests** → *Read and write*; **Metadata** → *Read-only* (selected automatically). Leave everything else at *No access*: in particular no **Workflows** permission, so the App can never change CI even if a diff tried to.
6. **Where can this GitHub App be installed?** → *Only on this account*. Click **Create GitHub App**.
7. On the App page, copy the **App ID** (a number): that is `GITHUB_APP_ID`.
8. Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads. Keep it out of the repository.
9. Left menu → **Install App** → **Install** on your account → choose **Only select repositories** and pick the repositories Delegate may open pull requests on. Every other repository gets a patch and a test report instead.

### Paste the key into Vercel

1. Vercel → *Project → Settings → Environment Variables* → **Add New**.
2. `GITHUB_APP_ID` = the App ID; `GITHUB_APP_SLUG` = the slug.
3. `GITHUB_APP_PRIVATE_KEY`: open the `.pem` file and paste the whole content, including the `-----BEGIN` and `-----END` lines, into the value field (multi-line values are fine). If your tooling needs one line, replace newlines with literal `\n` (`awk 'NF {printf "%s\\n", $0}' key.pem`); Delegate accepts both. Mark it **Sensitive**.
4. Redeploy. `/settings` shows "GitHub App configured" and an install link.

### Who gets real pull requests

- A pull request needs: an installation that covers the repository, the repository's tests passing after the change, and your approval of the exact diff on the run page (a 10-minute wait without a decision counts as a rejection).
- Visitors get pull requests only on repositories covered by an installation they connected to their own workspace (Connect GitHub). Pasting someone else's repository URL produces a patch.
- `DELEGATE_OWNER_MODE=1` (development only; ignored when `NODE_ENV=production`) lets your own App installation be used directly, from your own machine.
- The installation token is minted per run for the single input repository with only `contents` and `pull_requests` write, is never logged or stored, and never enters the sandbox: the server builds the commit through the GitHub API.
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
