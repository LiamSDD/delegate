import Link from "next/link";

export default function DocsNotFound() {
  return (
    <div className="flex max-w-[45rem] flex-col gap-5">
      <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Docs · 404</p>
      <h1 className="font-serif text-display-sm tracking-display text-text sm:text-display-md">
        There is no docs page at this address
      </h1>
      <p className="text-md text-text-muted">
        The page may have moved, or the link is mistyped. Every page is listed in the menu, and
        search covers every title and heading.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/docs"
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
        >
          Docs home
        </Link>
        <Link
          href="/docs/architecture/adr"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Decision records
        </Link>
      </div>
    </div>
  );
}
