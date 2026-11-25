export interface GitHubAppStatus {
  configured: boolean;
  slug: string | null;
  ownerMode: boolean;
  shipEnabled: boolean;
  sandbox: "local" | "vercel" | "invalid";
}

function Status({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span
      className={
        ok
          ? "rounded-sm bg-success-soft px-1.5 font-mono text-2xs text-success"
          : "rounded-sm bg-surface-2 px-1.5 font-mono text-2xs text-text-muted"
      }
    >
      {children}
    </span>
  );
}

export function GitHubAppSetup({ status }: { status: GitHubAppStatus }) {
  const installUrl =
    status.slug === null
      ? null
      : `https://github.com/apps/${encodeURIComponent(status.slug)}/installations/new`;
  return (
    <section aria-labelledby="github-app" className="flex flex-col gap-4">
      <h2 id="github-app" className="font-mono text-2xs tracking-label text-text-subtle uppercase">
        Available now · Ship-a-PR authorisation
      </h2>
      <p className="text-base text-text">
        Ship-a-PR opens pull requests only through a GitHub App that you create and install on the
        repositories you choose. A visitor gets pull requests only on repositories their own
        connected installation covers; every other repository gets a downloadable patch and test
        report instead.
      </p>
      <ul className="flex flex-wrap gap-2">
        <li>
          <Status ok={status.shipEnabled}>
            {status.shipEnabled ? "Ship-a-PR on" : "Ship-a-PR off (DELEGATE_SHIP_A_PR)"}
          </Status>
        </li>
        <li>
          <Status ok={status.configured}>
            {status.configured ? "GitHub App configured" : "GitHub App not configured"}
          </Status>
        </li>
        <li>
          <Status ok={status.ownerMode}>
            {status.ownerMode ? "owner mode: owner install usable" : "owner mode off"}
          </Status>
        </li>
        <li>
          <Status ok={status.sandbox !== "invalid"}>{`sandbox: ${status.sandbox}`}</Status>
        </li>
      </ul>
      <ol className="flex flex-col gap-2 text-sm text-text-muted">
        <li>
          1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New): permissions
          Contents read &amp; write, Pull requests read &amp; write, Metadata read; webhook off.
        </li>
        <li>
          2. Generate a private key and set <code className="font-mono text-xs">GITHUB_APP_ID</code>
          , <code className="font-mono text-xs">GITHUB_APP_PRIVATE_KEY</code> and{" "}
          <code className="font-mono text-xs">GITHUB_APP_SLUG</code> in the environment (never in
          the repository).
        </li>
        <li>
          3. Install the App on <span className="text-text">only the repositories</span> Delegate
          may open pull requests on
          {installUrl === null ? (
            "."
          ) : (
            <>
              :{" "}
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-text underline underline-offset-4 hover:text-accent"
              >
                install {status.slug}
              </a>
              .
            </>
          )}
        </li>
        <li>
          4. Pull requests also need owner mode and passing tests, and every one waits for your
          approval of the exact diff. Step-by-step:{" "}
          <code className="font-mono text-xs">docs/DEPLOY.md</code>.
        </li>
      </ol>
    </section>
  );
}
