import { expect, it } from "vitest";

import { createOpenAICompatibleProvider } from "../providers/openai-compatible";
import { loadRepoEnv } from "./env";

const MODELS = (process.env.PROBE_MODELS ?? "").split(",").filter((model) => model !== "");
const VARIANTS: { name: string; quirks: string[]; reasoningEffort?: "low" }[] = [
  { name: "default", quirks: [] },
  { name: "effort-low", quirks: [], reasoningEffort: "low" },
  { name: "disable-thinking", quirks: ["disable-thinking"] },
];

it("measures whether reasoning switches shorten reasoning", async () => {
  const apiKey = loadRepoEnv().NVIDIA_API_KEY;
  expect(apiKey).toBeTruthy();
  if (apiKey === undefined) return;
  const provider = createOpenAICompatibleProvider({
    id: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey,
  });
  for (const model of MODELS)
    for (const variant of VARIANTS) {
      const started = Date.now();
      let reasoning = 0;
      let text = "";
      let stop = "";
      try {
        for await (const event of provider.stream({
          model,
          system:
            'Write 6 evaluation questions a customer might ask about a privacy-focused web analytics product. Reply with only JSON: {"cases":[{"question":string,"answerable":boolean}]}.',
          messages: [
            { role: "user", content: "Product: an open-source, cookieless analytics tool." },
          ],
          maxTokens: 3_000,
          quirks: variant.quirks,
          ...(variant.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: variant.reasoningEffort }),
        })) {
          if (event.type === "reasoning_delta") reasoning += event.text.length;
          if (event.type === "text_delta") text += event.text;
          if (event.type === "stop") stop = event.reason;
        }
      } catch (error) {
        stop = error instanceof Error ? error.name : "error";
      }
      console.warn(
        `${model} ${variant.name}: ${Date.now() - started} ms, reasoning ${reasoning} chars, text ${text.length} chars, stop ${stop}, json ${text.includes('"cases"')}`,
      );
    }
}, 600_000);
