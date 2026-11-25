import { MilestoneBadge } from "@/components/milestone-badge";
import {
  isMissionLive,
  type Mission,
  MISSION_GROUPS,
  missionById,
  missionsInGroup,
} from "@/lib/missions";

const ROW_GRID =
  "md:grid md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,13rem)_5.5rem_4.5rem] md:items-baseline md:gap-6";

function CellLabel({ children }: { children: string }) {
  return (
    <span className="mr-2 font-mono text-2xs tracking-label text-text-subtle uppercase md:sr-only">
      {children}
    </span>
  );
}

function MissionRow({ mission }: { mission: Mission }) {
  return (
    <li className={`flex flex-col gap-1.5 border-t border-border py-4 ${ROW_GRID}`}>
      <div className="flex items-center justify-between gap-3 md:block">
        <h4 className="text-base font-medium text-text">{mission.name}</h4>
        <MilestoneBadge id={mission.arrives} live={isMissionLive(mission)} className="md:hidden" />
      </div>
      <p className="text-sm text-text-muted">{mission.outcome}</p>
      <p className="text-sm text-text-muted">
        <CellLabel>Inputs</CellLabel>
        {mission.inputs}
      </p>
      <p className="font-mono text-xs text-text tabular">
        <CellLabel>Target</CellLabel>
        {mission.durationTarget ?? (
          <>
            <span aria-hidden="true" className="text-text-subtle">
              —
            </span>
            <span className="sr-only">No duration target yet</span>
          </>
        )}
      </p>
      <div className="hidden md:block md:justify-self-end">
        <MilestoneBadge id={mission.arrives} live={isMissionLive(mission)} />
      </div>
    </li>
  );
}

export function MissionCatalogue() {
  const customGoal = missionById("custom-goal");
  return (
    <div className="flex flex-col gap-10">
      <div
        aria-hidden="true"
        className={`hidden font-mono text-2xs tracking-label text-text-subtle uppercase ${ROW_GRID} md:-mb-8`}
      >
        <span>Mission</span>
        <span>Outcome</span>
        <span>Inputs</span>
        <span>Target</span>
        <span className="justify-self-end">Status</span>
      </div>
      {MISSION_GROUPS.map((group) => (
        <section key={group.id} aria-labelledby={`group-${group.id}`}>
          <h3
            id={`group-${group.id}`}
            className="flex items-baseline gap-3 border-b border-border-strong pb-2 text-sm"
          >
            <span className="font-mono text-xs text-text-subtle tabular">{group.code}</span>
            <span className="font-medium text-text">{group.name}</span>
            <span className="text-text-subtle">{group.setup}</span>
          </h3>
          <ul className="[&>li:first-child]:border-t-0">
            {missionsInGroup(group.id).map((mission) => (
              <MissionRow key={mission.id} mission={mission} />
            ))}
          </ul>
        </section>
      ))}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-strong pt-4 text-sm text-text-muted">
        <span className="font-mono text-xs text-text-subtle">E</span>
        <span className="font-medium text-text">{customGoal.name}</span>
        <span>{customGoal.outcome}</span>
        <MilestoneBadge id={customGoal.arrives} className="ml-auto" />
      </p>
    </div>
  );
}
