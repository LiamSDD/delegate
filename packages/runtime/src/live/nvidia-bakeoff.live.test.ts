import { mkdirSync, writeFileSync } from "node:fs";

import { expect, it } from "vitest";
import { z } from "zod";

import { extractJson } from "../agent/structured";
import {
  QUIRK_DISABLE_THINKING,
  createOpenAICompatibleProvider,
} from "../providers/openai-compatible";
import { type ModelRequest, type ToolCall } from "../providers/types";
import { loadRepoEnv } from "./env";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const ROUNDS = 2;

interface Candidate {
  model: string;
  quirks: string[];
  reasoningEffort?: "low";
  firstTokenMs: number;
  totalMs: number;
  parallelTasks?: boolean;
}

const FAST_TIMEOUTS = { firstTokenMs: 60_000, totalMs: 120_000 };

const CANDIDATES: Candidate[] = [
  {
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    quirks: [QUIRK_DISABLE_THINKING],
    ...FAST_TIMEOUTS,
  },
  { model: "mistralai/mistral-large-4-1t-a52b", quirks: [], ...FAST_TIMEOUTS },
  { model: "minimaxai/minimax-m3.1-flash", quirks: [], ...FAST_TIMEOUTS },
  { model: "stepfun-ai/step-5-preview", quirks: [], ...FAST_TIMEOUTS },
  {
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    quirks: [QUIRK_DISABLE_THINKING],
    ...FAST_TIMEOUTS,
  },
  {
    model: "moonshotai/kimi-k3.1-pro",
    quirks: ["echo-reasoning-content"],
    reasoningEffort: "low",
    firstTokenMs: 300_000,
    totalMs: 600_000,
    parallelTasks: true,
  },
];

const JUDGES = [
  { model: "nvidia/nemotron-3-ultra-550b-a55b", quirks: [QUIRK_DISABLE_THINKING] },
  { model: "minimaxai/minimax-m3.1-flash", quirks: [] },
  { model: "mistralai/mistral-large-4-1t-a52b", quirks: [] },
];

const PAGE = `Harbourline Freight is a family-owned logistics company founded in 1987 in Rotterdam.
We operate 140 refrigerated trucks and two cross-dock warehouses in Venlo and Antwerp.
Customers book pallet slots through our portal or by emailing bookings@harbourline.example; about 60% of bookings still arrive by email.
Our customer service team of 12 answers delivery-status questions around the clock.
In 2025 we launched a CO2 report for every shipment, sent monthly as a PDF to account managers.`;

const EVIDENCE = [
  "About 60% of bookings still arrive by email to bookings@harbourline.example.",
  "Our customer service team of 12 answers delivery-status questions around the clock.",
  "We operate 140 refrigerated trucks and two cross-dock warehouses in Venlo and Antwerp.",
  "A CO2 report for every shipment is sent monthly as a PDF to account managers.",
];

const ExtractionSchema = z.object({
  facts: z.array(z.object({ claim: z.string().min(1), quote: z.string().min(1) })).min(3),
});

const WriteupSchema = z.object({
  title: z.string().min(1),
  workflow: z.string().min(1),
  automation: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
});

const JudgeSchema = z.object({
  specificity: z.number().min(1).max(5),
  grounding: z.number().min(1).max(5),
});

const ReasoningSchema = z.object({ answer: z.number() });

const noArgs = z.object({});
const weatherTool = {
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
};
const currencyTool = {
  name: "convert_currency",
  description: "Convert an amount between ISO currency codes.",
  inputSchema: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
};
const timeTool = { name: "get_time", description: "Current UTC time.", inputSchema: noArgs };

type TaskId = "extraction" | "tools" | "writeup" | "reasoning";
const ALL_TASKS: TaskId[] = ["extraction", "tools", "writeup", "reasoning"];
const TASKS: TaskId[] = ALL_TASKS.filter((task) =>
  (process.env.BAKEOFF_TASKS ?? ALL_TASKS.join(",")).split(",").includes(task),
);

interface CallOutcome {
  text: string;
  toolCalls: ToolCall[];
  firstTokenMs: number | null;
  totalMs: number;
  error?: string;
}

interface Attempt {
  model: string;
  task: TaskId;
  round: number;
  firstTokenMs: number | null;
  totalMs: number;
  passed: boolean;
  score: number;
  note: string;
}

function redact(text: string): string {
  return text.replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-[redacted]").slice(0, 160);
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function requestFor(task: TaskId): Omit<ModelRequest, "model" | "quirks"> {
  switch (task) {
    case "extraction":
      return {
        system:
          'Extract facts from the page. Reply with only JSON: {"facts":[{"claim":string,"quote":string}]}. Every quote must be copied verbatim from the page. At least 4 facts.',
        messages: [{ role: "user", content: `<page>\n${PAGE}\n</page>` }],
        maxTokens: 4_000,
        temperature: 0,
      };
    case "tools":
      return {
        system: "You are an agent. Use the tools; call every tool needed in this turn.",
        messages: [
          {
            role: "user",
            content:
              "In one turn, call the tools to get the weather in Lisbon and to convert 250 EUR to USD.",
          },
        ],
        tools: [weatherTool, currencyTool, timeTool],
        maxTokens: 4_000,
        temperature: 0,
      };
    case "writeup":
      return {
        system:
          'You are an automation consultant. From the evidence only, write the single best AI automation opportunity for this company. Reply with only JSON: {"title":string,"workflow":string,"automation":string,"evidence":[verbatim evidence lines]}. Be specific to this company; no generic advice.',
        messages: [
          {
            role: "user",
            content: `Company: Harbourline Freight\nEvidence:\n${EVIDENCE.map((line) => `- ${line}`).join("\n")}`,
          },
        ],
        maxTokens: 4_000,
        temperature: 0.2,
      };
    case "reasoning":
      return {
        system: 'Solve the problem. Reply with only JSON: {"answer": number}.',
        messages: [
          {
            role: "user",
            content:
              "A depot loads 7 pallets per truck. 3 trucks leave full, and a fourth truck takes the remaining 5 pallets. Then 2 pallets are returned and reloaded onto a fifth truck with 9 other pallets. How many pallets were loaded in total across all trucks, counting the reloaded ones again?",
          },
        ],
        maxTokens: 4_000,
        temperature: 0,
      };
  }
}

const REASONING_ANSWER = 3 * 7 + 5 + (2 + 9);

async function call(
  apiKey: string,
  candidate: { model: string; quirks: string[]; reasoningEffort?: "low" },
  request: Omit<ModelRequest, "model" | "quirks">,
  timeouts: { firstTokenMs: number; totalMs: number },
): Promise<CallOutcome> {
  const provider = createOpenAICompatibleProvider({ id: "nvidia", baseUrl: BASE_URL, apiKey });
  const controller = new AbortController();
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let text = "";
  const toolCalls: ToolCall[] = [];
  const firstTimer = setTimeout(() => {
    if (firstTokenMs === null) controller.abort();
  }, timeouts.firstTokenMs);
  try {
    for await (const event of provider.stream(
      {
        ...request,
        model: candidate.model,
        quirks: candidate.quirks,
        ...(candidate.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: candidate.reasoningEffort }),
      },
      { signal: controller.signal, timeouts },
    )) {
      if (firstTokenMs === null && event.type !== "usage" && event.type !== "stop")
        firstTokenMs = Date.now() - started;
      if (event.type === "text_delta") text += event.text;
      if (event.type === "tool_call_complete") toolCalls.push(event.call);
      if (event.type === "stop" && event.reason === "error")
        return {
          text,
          toolCalls,
          firstTokenMs,
          totalMs: Date.now() - started,
          error: event.raw ?? "error",
        };
    }
    return { text, toolCalls, firstTokenMs, totalMs: Date.now() - started };
  } catch (error) {
    const message = controller.signal.aborted
      ? `no first token within ${timeouts.firstTokenMs} ms`
      : error instanceof Error
        ? error.message
        : "failed";
    return { text, toolCalls, firstTokenMs, totalMs: Date.now() - started, error: redact(message) };
  } finally {
    clearTimeout(firstTimer);
  }
}

function argsOf(call: ToolCall | undefined): Record<string, unknown> {
  if (call === undefined) return {};
  try {
    return JSON.parse(call.argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function grade(
  apiKey: string,
  candidate: Candidate,
  task: TaskId,
  outcome: CallOutcome,
): Promise<{ passed: boolean; score: number; note: string }> {
  if (outcome.error !== undefined) return { passed: false, score: 0, note: outcome.error };
  switch (task) {
    case "extraction": {
      const parsed = ExtractionSchema.safeParse(extractJson(outcome.text));
      if (!parsed.success) return { passed: false, score: 0, note: "schema invalid" };
      const page = normalise(PAGE);
      const exact = parsed.data.facts.filter((fact) => page.includes(normalise(fact.quote)));
      const passed = exact.length === parsed.data.facts.length;
      return {
        passed,
        score: exact.length / parsed.data.facts.length,
        note: `${exact.length}/${parsed.data.facts.length} quotes exact`,
      };
    }
    case "tools": {
      const weather = outcome.toolCalls.find((entry) => entry.name === "get_weather");
      const currency = outcome.toolCalls.find((entry) => entry.name === "convert_currency");
      const w = argsOf(weather);
      const c = argsOf(currency);
      const weatherOk = typeof w.city === "string" && /lisbo/i.test(w.city);
      const currencyOk =
        Number(c.amount) === 250 &&
        String(c.from).toUpperCase() === "EUR" &&
        String(c.to).toUpperCase() === "USD";
      const extra = outcome.toolCalls.some((entry) => entry.name === "get_time");
      const score = (Number(weatherOk) + Number(currencyOk)) / 2 - (extra ? 0.25 : 0);
      return {
        passed: weatherOk && currencyOk && !extra,
        score: Math.max(0, score),
        note: outcome.toolCalls.map((entry) => entry.name).join("+") || "no tool calls",
      };
    }
    case "writeup": {
      const parsed = WriteupSchema.safeParse(extractJson(outcome.text));
      if (!parsed.success) return { passed: false, score: 0, note: "schema invalid" };
      for (const judge of JUDGES.filter((entry) => entry.model !== candidate.model)) {
        const verdict = await call(
          apiKey,
          judge,
          {
            system:
              'You grade an automation opportunity write-up against its evidence. Rubric: specificity 1-5 (5 = names this company\'s concrete workflow, volumes and systems; 1 = generic advice). grounding 1-5 (5 = every claim follows from the evidence; 1 = invents facts). Reply with only JSON: {"specificity":n,"grounding":n}.',
            messages: [
              {
                role: "user",
                content: `Evidence:\n${EVIDENCE.join("\n")}\n\nWrite-up:\n${JSON.stringify(parsed.data)}`,
              },
            ],
            maxTokens: 2_000,
            temperature: 0,
          },
          FAST_TIMEOUTS,
        );
        const scored = JudgeSchema.safeParse(extractJson(verdict.text));
        if (!scored.success) continue;
        const mean = (scored.data.specificity + scored.data.grounding) / 2;
        return {
          passed: mean >= 4,
          score: mean / 5,
          note: `spec ${scored.data.specificity} ground ${scored.data.grounding} (judge ${judge.model.split("/")[1] ?? judge.model})`,
        };
      }
      return { passed: false, score: 0, note: "every judge failed" };
    }
    case "reasoning": {
      const parsed = ReasoningSchema.safeParse(extractJson(outcome.text));
      if (!parsed.success) return { passed: false, score: 0, note: "schema invalid" };
      const passed = parsed.data.answer === REASONING_ANSWER;
      return { passed, score: Number(passed), note: `answer ${parsed.data.answer}` };
    }
  }
}

async function runTask(
  apiKey: string,
  candidate: Candidate,
  task: TaskId,
  round: number,
): Promise<Attempt> {
  const outcome = await call(apiKey, candidate, requestFor(task), candidate);
  const graded = await grade(apiKey, candidate, task, outcome);
  return {
    model: candidate.model,
    task,
    round,
    firstTokenMs: outcome.firstTokenMs,
    totalMs: outcome.totalMs,
    ...graded,
  };
}

const DISABLE_THINKING = (process.env.BAKEOFF_DISABLE_THINKING ?? "").split(",");

async function runCandidate(apiKey: string, listed: Candidate): Promise<Attempt[]> {
  const candidate =
    DISABLE_THINKING.includes(listed.model) && !listed.quirks.includes(QUIRK_DISABLE_THINKING)
      ? { ...listed, quirks: [...listed.quirks, QUIRK_DISABLE_THINKING] }
      : listed;
  const attempts: Attempt[] = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    if (candidate.parallelTasks === true) {
      const batch = await Promise.all(TASKS.map((task) => runTask(apiKey, candidate, task, round)));
      attempts.push(...batch);
      if (batch.every((attempt) => attempt.firstTokenMs === null)) break;
    } else {
      for (const task of TASKS) attempts.push(await runTask(apiKey, candidate, task, round));
    }
  }
  return attempts;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

it("bakes off NVIDIA catalog chat models on Delegate-shaped tasks", async () => {
  const env = loadRepoEnv();
  const apiKey = env.NVIDIA_API_KEY;
  expect(apiKey, "NVIDIA_API_KEY must be set in .env.local").toBeTruthy();
  if (apiKey === undefined) return;
  const results = (
    await Promise.all(
      CANDIDATES.filter(
        (candidate) =>
          process.env.BAKEOFF_MODELS === undefined ||
          process.env.BAKEOFF_MODELS.split(",").includes(candidate.model),
      ).map((candidate) => runCandidate(apiKey, candidate)),
    )
  ).flat();
  const summary = CANDIDATES.map((candidate) => {
    const mine = results.filter((attempt) => attempt.model === candidate.model);
    const byTask = Object.fromEntries(
      TASKS.map((task) => {
        const runs = mine.filter((attempt) => attempt.task === task);
        return [
          task,
          {
            pass: `${runs.filter((attempt) => attempt.passed).length}/${runs.length}`,
            score: runs.length === 0 ? 0 : runs.reduce((sum, a) => sum + a.score, 0) / runs.length,
          },
        ];
      }),
    );
    const quality = TASKS.reduce((sum, task) => sum + (byTask[task]?.score ?? 0), 0) / TASKS.length;
    const responded = mine.filter((attempt) => attempt.firstTokenMs !== null);
    return {
      model: candidate.model,
      quality: Number(quality.toFixed(3)),
      responded: `${responded.length}/${mine.length}`,
      medianFirstTokenMs: median(responded.map((attempt) => attempt.firstTokenMs ?? 0)),
      medianTotalMs: median(responded.map((attempt) => attempt.totalMs)),
      byTask,
    };
  }).sort((a, b) => b.quality - a.quality);
  const out = process.env.BAKEOFF_OUT;
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      `${out}/bakeoff.json`,
      JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2),
    );
  }
  console.warn(JSON.stringify(summary, null, 2));
  for (const attempt of results)
    console.warn(
      `${attempt.model} ${attempt.task}#${attempt.round} ttft=${attempt.firstTokenMs ?? "-"} total=${attempt.totalMs} ${attempt.passed ? "PASS" : "FAIL"} ${attempt.score.toFixed(2)} ${attempt.note}`,
    );
  expect(results.length).toBeGreaterThan(0);
}, 1_200_000);
