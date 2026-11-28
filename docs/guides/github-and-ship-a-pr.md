# Connect GitHub and Ship-a-PR

Ship-a-PR takes one improvement from a Repo X-ray, implements it in a sandbox, runs the repository's own checks before and after, and then asks you. If you approve and the repository is one you connected, it opens a pull request. In every other case you get a patch and the test reports. Nothing is pushed anywhere without your approval of the exact diff.

## What the deployment needs

Ship-a-PR and Connect GitHub are optional parts of a deployment. [Deploy on Vercel and Neon](../DEPLOY.md) has the click-by-click setup for both.

| Feature | Needs |
|---|---|
| Ship-a-PR | `DELEGATE_SHIP_A_PR=1`. Without it the mission answers 503 and no sandbox time is spent. |
| Pull requests | A GitHub App you own: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG`. |
| Connect GitHub | The same App's `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. |

When the App is not configured, the GitHub section of the Connections page says so, and pull requests fall back to downloadable patches.

## Connect GitHub

Open https://trydelegate.app/settings/connections and go to **GitHub**.

1. Choose **Connect GitHub**. GitHub asks you to authorise the App.
2. Choose **Install on repositories** and pick the repositories Delegate may open pull requests on. Selecting only the repositories you need is the safer choice.
3. Back in Delegate, the installation appears with the account name, the repositories recorded for it and the GitHub user who connected it. **Unlink** removes the link from this workspace.

Behind those clicks:

- The request to GitHub carries a `state` signed with the session secret and bound to your session, a nonce cookie and a 10-minute window. A response that does not match is ignored.
- Delegate links the installation only after asking GitHub, with your authorisation, whether your account can access it. It then drops your user token. The token is never stored.
- For an installation limited to selected repositories, only the repositories you can push to are recorded. An installation on all repositories is recorded as unverified, and push access is checked for the specific repository when a change is shipped.

## Ship a change

1. Run a Repo X-ray on the repository. See [missions](missions.md#repo-x-ray).
2. On its run page, choose **Ship it** on one of the ranked improvements. A new run starts for that improvement.
3. The run follows a fixed plan: `prepare`, `baseline`, `implement`, `verify`, `ship`. Its page shows the repository's checks before and after, the diff and the log of every command that ran in the sandbox.
4. When the change is ready, an approval card asks either **Open a pull request on owner/repo?** or **Hand over this change as a patch?**, with the branch, the number of files and the lines added and removed. Approve or reject.

If nobody decides within 10 minutes, nothing is shipped.

## Who gets a real pull request

A pull request is opened only when all of these hold:

- The workspace has a connected installation that covers the repository. Pasting the URL of a repository you have not connected produces a patch.
- The GitHub user who connected the installation has admin, maintain or write permission on that repository. Delegate checks this with GitHub when it ships.
- The repository's tests pass after the change.
- A person approved the diff on the run page.

Runs started without a reviewer attached never ship.

## What the Engineer can and cannot do

The Engineer is the agent that writes the change. It is an unprivileged agent: it has to read repository content, which is untrusted, so it is given nothing worth stealing.

- **Five tools.** `read_file`, `list_dir`, `search`, `write_file` and `run`. Their capabilities reach nothing outside the sandbox.
- **Confined paths.** No absolute paths, no `..`, nothing under `.git`, nothing under `.github/workflows`. Paths are resolved inside the sandbox, so a symlink cannot point a write outside the repository.
- **Allowlisted commands.** `run` accepts only the commands detected from the repository's `package.json` scripts, `pyproject.toml` or `Makefile`, plus `git status --short` and `git diff --stat`. Commands are passed as arguments, never as a shell string, each with its own timeout.
- **No credentials.** The sandbox has no environment secrets and no git credentials.
- **Bounded work.** At most three rounds of implement and verify, each with up to 10 model turns and 30 tool calls, and 12 minutes in total.

In production the sandbox is a Vercel Sandbox microVM. Its network is open to GitHub and package registries only while cloning and installing, and to package registries after that. The local process sandbox used in development runs commands in a temporary directory with a scrubbed environment. It is not an isolation boundary, and it refuses to start in production.

## Why the pull request matches what you approved

- The final diff is checked again before you see it: no workflow files, no symlinks, no submodules, at most 50 files and 400 KB.
- The approved diff pins every changed file's bytes with a SHA-256 hash, and the sandbox is stopped after the checks run.
- The server builds the commit itself, through the GitHub API, from those pinned bytes. It never reads the files from the sandbox again.
- The installation token is minted for that one run and that one repository, with write access to contents and pull requests only. It is never logged, stored or passed to the sandbox.

The GitHub App has no Workflows permission, so it could not change CI even if a diff tried to. ADR 0011 explains the design, and the [security model](../SECURITY.md#controls) lists the tests behind each of these controls.

## Status

The flow is covered by mission tests and red-team cases that run the whole mission with a compromised Engineer and a recording fake GitHub. As the [case study](../CASE_STUDY.md#not-done-yet) says, it has not yet opened a live pull request on a public repository.
