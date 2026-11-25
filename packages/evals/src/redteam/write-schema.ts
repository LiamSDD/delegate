import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { RedteamCaseSchema } from "./schema";

const target = fileURLToPath(new URL("../../datasets/redteam/schema.v2.json", import.meta.url));
writeFileSync(
  target,
  `${JSON.stringify(z.toJSONSchema(RedteamCaseSchema, { io: "input" }), null, 2)}\n`,
);
process.stdout.write(`Wrote ${target}\n`);
