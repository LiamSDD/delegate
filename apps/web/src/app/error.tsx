"use client";

import Link from "next/link";
import { useEffect } from "react";

function digestOf(error: unknown): string | null {
  if (error instanceof Error && "digest" in error && typeof error.digest === "string")
    return error.digest;
  return null;
}

export default function ErrorBoundary({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = digestOf(error);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      className="mx-auto flex max-w-content flex-col gap-6 px-6 pt-16 pb-24 md:pt-24"
      role="alert"
    >
      <p className="font-mono text-2xs tracking-label text-danger uppercase">Error</p>
      <h1 className="font-serif text-display-sm tracking-display">This screen failed to render</h1>
      <p className="max-w-xl text-md text-text-muted">
        The rest of Delegate is unaffected. Try again; if it keeps failing, the reference below
        matches the server log.
      </p>
      {digest === null ? null : (
        <p className="font-mono text-xs text-text-muted">
          Reference <span className="text-text">{digest}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
