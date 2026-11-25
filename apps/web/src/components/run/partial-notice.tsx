export interface PartialInfo {
  reason: string;
  skippedSteps: readonly string[];
}

export function PartialNotice({ partial }: { partial: PartialInfo | undefined }) {
  if (partial === undefined) return null;
  return (
    <p
      role="note"
      className="rounded-sm border border-border-strong px-3 py-2 text-xs text-text-muted"
    >
      <span className="font-medium text-text">Partial result.</span> {partial.reason}
      {partial.skippedSteps.length === 0 ? null : ` Skipped: ${partial.skippedSteps.join(", ")}.`}
    </p>
  );
}
