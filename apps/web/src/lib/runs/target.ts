export const GOAL_TARGET_CHARS = 60;

export function runTarget(input: Record<string, unknown>): string | null {
  if (typeof input.url === "string") {
    try {
      return new URL(input.url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }
  if (typeof input.goal !== "string") return null;
  const goal = input.goal.replace(/\s+/g, " ").trim();
  if (goal === "") return null;
  return goal.length <= GOAL_TARGET_CHARS ? goal : `${goal.slice(0, GOAL_TARGET_CHARS - 1)}…`;
}
