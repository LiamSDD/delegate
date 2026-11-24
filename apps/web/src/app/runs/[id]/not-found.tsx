import Link from "next/link";

export default function RunNotFound() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-4 px-6 pt-16 pb-24 md:pt-24">
      <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Run · 404</p>
      <h1 className="font-serif text-display-md tracking-display">This run is not available</h1>
      <p className="max-w-xl text-md text-text-muted">
        It does not exist, belongs to another browser session, or was deleted. Demo runs are deleted
        after 7 days.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/?focus=mission"
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
        >
          New run
        </Link>
        <Link
          href="/runs"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Your runs
        </Link>
      </div>
    </div>
  );
}
