export default function AuditLoading() {
  return (
    <div
      className="mx-auto flex max-w-content flex-col gap-8 px-4 pt-16 pb-24 sm:px-6 md:pt-24"
      aria-busy="true"
    >
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          Mission Control / Audit log
        </p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          Every policy decision, newest first
        </h1>
        <p role="status" className="text-sm text-text-muted">
          Reading the event log…
        </p>
      </header>
      <ol aria-hidden="true" className="flex flex-col rounded-xl border border-border bg-surface">
        {[0, 1, 2, 3].map((row) => (
          <li
            key={row}
            className="flex animate-pulse flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0"
          >
            <span className="h-4 w-24 rounded-sm bg-surface-2" />
            <span className="h-4 w-2/3 rounded-sm bg-surface-2" />
          </li>
        ))}
      </ol>
    </div>
  );
}
