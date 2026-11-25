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
