import { z } from "zod";

import { type QuarantineTask } from "../../quarantine/reader";

export const GOAL_TOPICS = [
  "company",
  "offering",
  "customers",
  "practice",
  "tooling",
  "metric",
  "example",
  "risk",
  "other",
] as const;
export type GoalTopic = (typeof GOAL_TOPICS)[number];

export function goalReaderTask(goal: string): QuarantineTask<{ topic: GoalTopic }> {
  return {
    name: "custom-goal",
    instructions: `Extract facts that would help a team pursue this goal, stated by the user: ${JSON.stringify(goal)}. Keep facts about the organisation named in the goal (what it sells, who it serves, how it operates, what it has announced), established practices and methods for the goal's topic, tools and technologies, measurable figures, concrete examples and known risks or limitations.`,
    extraSchema: z.object({ topic: z.enum(GOAL_TOPICS).catch("other") }),
    extraDescription: `"topic": one of ${GOAL_TOPICS.join(", ")}`,
    maxFactsPerSource: 6,
  };
}
