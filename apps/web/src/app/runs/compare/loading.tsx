import { CompareShell } from "@/components/run/compare-view";

export default function CompareLoading() {
  return (
    <CompareShell>
      <div role="status" aria-live="polite" className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Run compare</p>
        <span className="sr-only">Loading both event logs…</span>
        <div
          aria-hidden="true"
          className="h-9 w-2/3 rounded-md bg-surface-2 motion-safe:animate-pulse"
        />
        <div aria-hidden="true" className="h-5 w-full max-w-xl rounded-md bg-surface-2" />
        <div aria-hidden="true" className="mt-4 h-72 rounded-xl border border-border bg-surface" />
        <div aria-hidden="true" className="h-40 rounded-xl border border-border bg-surface" />
      </div>
    </CompareShell>
  );
}
