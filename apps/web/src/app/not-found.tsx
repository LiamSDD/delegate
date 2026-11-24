import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-6 pt-16 pb-24 md:pt-24">
      <p
        className="font-serif text-display-lg leading-none text-text-subtle tabular"
        aria-hidden="true"
      >
        404
      </p>
      <h1 className="font-serif text-display-sm tracking-display">
        This route is not part of Delegate
      </h1>
      <p className="max-w-xl text-md text-text-muted">
        The link may be mistyped, or it points at a screen from a later milestone that does not
        exist yet.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
        >
          Go home
        </Link>
        <Link
          href="/runs"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Runs
        </Link>
        <Link
          href="/docs"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Docs
        </Link>
      </div>
    </div>
  );
}
