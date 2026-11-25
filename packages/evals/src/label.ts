import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import { RESULTS_DIR } from "./cli";
import { runLabelSession } from "./label/session";
import { EVAL_MISSIONS, missionAdapter } from "./missions";

const ArgsSchema = z.object({
  mission: z.enum(EVAL_MISSIONS, {
    error: `--mission must be one of ${EVAL_MISSIONS.join(", ")}`,
  }),
  labeller: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "--labeller is a short kebab-case handle, not a name"),
  run: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    mission: { type: "string" },
    labeller: { type: "string", default: "owner" },
    run: { type: "string" },
    limit: { type: "string" },
  },
  strict: true,
});
const args = ArgsSchema.parse(values);
const readline = createInterface({ input: process.stdin, output: process.stdout });
try {
  await runLabelSession(
    missionAdapter(args.mission),
    {
      resultsDir: RESULTS_DIR,
      labeller: args.labeller,
      now: () => new Date(),
      ...(args.run === undefined ? {} : { run: args.run }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    },
    {
      ask: (question) => readline.question(question),
      print: (text) => {
        process.stdout.write(`${text}\n`);
      },
    },
  );
} finally {
  readline.close();
}
