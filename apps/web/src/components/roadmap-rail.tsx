import { CURRENT_MILESTONE, type MilestoneId, MILESTONES } from "@/lib/roadmap";
import { repoFileUrl } from "@/lib/site";
import { cn } from "@/lib/utils";

export function RoadmapRail({ target }: { target: MilestoneId }) {
  const currentIndex = MILESTONES.findIndex((milestone) => milestone.id === CURRENT_MILESTONE);
  return (
    <nav aria-label="Roadmap" className="flex flex-col gap-4">
      <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Roadmap</p>
      <ol className="relative flex flex-col before:absolute before:top-2 before:bottom-2 before:left-[3.5px] before:w-px before:bg-border">
        {MILESTONES.map((milestone, index) => {
          const isCurrent = milestone.id === CURRENT_MILESTONE;
          const isTarget = milestone.id === target;
          const isPast = index < currentIndex;
          return (
            <li
              key={milestone.id}
              aria-current={isCurrent ? "step" : undefined}
              className="relative flex items-baseline gap-4 py-1.5 text-sm"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "relative top-[-1px] size-2 shrink-0 self-center rounded-full border",
                  isTarget
                    ? "border-accent bg-accent"
                    : isCurrent
                      ? "border-text bg-bg"
                      : isPast
                        ? "border-text bg-text"
                        : "border-border-strong bg-bg",
                )}
              />
              <span
                className={cn(
                  "w-7 font-mono text-xs tabular",
                  isTarget ? "text-accent" : "text-text-subtle",
                )}
              >
                {milestone.id}
              </span>
              <span className={cn(isTarget || isCurrent ? "text-text" : "text-text-muted")}>
                {milestone.title}
              </span>
              {isCurrent ? (
                <span className="ml-auto font-mono text-2xs text-text-subtle">in progress</span>
              ) : null}
              {isTarget ? (
                <span className="ml-auto font-mono text-2xs text-accent">this page</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <a
        href={`${repoFileUrl("SPEC.md")}#roadmap`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs text-text-muted underline-offset-4 hover:text-text hover:underline"
      >
        Full roadmap in SPEC.md
      </a>
    </nav>
  );
}
