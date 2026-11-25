export default function SettingsLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex max-w-content flex-col gap-8 px-4 pt-16 pb-24 sm:px-6 md:pt-24"
    >
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Settings</p>
        <p role="status" className="text-sm text-text-muted">
          Reading your workspace…
        </p>
      </header>
      <div aria-hidden="true" className="flex flex-col rounded-xl border border-border bg-surface">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0 motion-safe:animate-pulse"
          >
            <span className="h-4 w-32 rounded-sm bg-surface-2" />
            <span className="h-4 w-2/3 rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
