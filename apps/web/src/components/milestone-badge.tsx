import { CURRENT_MILESTONE, isShipped, type MilestoneId, MILESTONES } from "@/lib/roadmap";
import { cn } from "@/lib/utils";

function isNext(id: MilestoneId): boolean {
  const current = MILESTONES.findIndex((milestone) => milestone.id === CURRENT_MILESTONE);
  return MILESTONES[current + 1]?.id === id;
}

export function MilestoneBadge({ id, className }: { id: MilestoneId; className?: string }) {
  if (isShipped(id)) {
    return (
      <span
        className={cn(
          "inline-flex h-5 items-center gap-1 rounded-sm border border-border px-1.5 font-mono text-2xs whitespace-nowrap text-success",
          className,
        )}
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        Live
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 font-mono text-2xs whitespace-nowrap tabular",
        isNext(id)
          ? "border-transparent bg-accent-soft text-accent"
          : "border-border bg-transparent text-text-muted",
        className,
      )}
    >
      <span className="sr-only">Available in</span>
      <span aria-hidden="true">In</span>
      {id}
    </span>
  );
}
