import { it, expect } from "vitest";
import { z } from "zod";

import { loadRepoEnv } from "./env";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const MAX_PROBES = 25;
const GAP_MS = 1_600;
const PROBE_TIMEOUT_MS = 75_000;

const CANDIDATE_PATTERNS: readonly RegExp[] = [
  /kimi/i,
  /deepseek-v4/i,
  /qwen3\.[5-9]/i,
  /qwen3-(coder|next|235b)/i,
  /glm-?[45]/i,
  /minimax/i,
  /nemotron.*(ultra|super)/i,
  /gpt-oss-120b/i,
  /llama-4/i,
  /mistral-large/i,
];

const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

const ChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            reasoning: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().optional(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .optional(),
                }),
              )
              .nullish(),
          })
          .optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
});

interface ProbeResult {
  model: string;
  status: number | "timeout" | "network";
  ttfbMs: number | null;
  firstTokenMs: number | null;
  firstContentMs: number | null;
  totalMs: number;
  toolCall: "correct" | "wrong" | "none";
  finish: string;
}

function redact(text: string): string {
  return text.replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-[redacted]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rankCandidates(ids: readonly string[]): string[] {
  const picked: string[] = [];
  for (const pattern of CANDIDATE_PATTERNS) {
    for (const id of ids) {
      if (pattern.test(id) && !picked.includes(id) && !/embed|reward|guard|vl\b|vision/i.test(id))
        picked.push(id);
    }
  }
  return picked.slice(0, MAX_PROBES);
}

async function probe(apiKey: string, model: string): Promise<ProbeResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  const result: ProbeResult = {
    model,
    status: "network",
    ttfbMs: null,
    firstTokenMs: null,
    firstContentMs: null,
    totalMs: 0,
    toolCall: "none",
    finish: "",
  };
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 600,
        temperature: 0,
        messages: [
          { role: "system", content: "You are a terse assistant. Use tools when they help." },
          { role: "user", content: "What is the weather in Paris right now? Call the tool." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Current weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: "auto",
      }),
    });
    result.status = response.status;
    result.ttfbMs = elapsed();
    if (!response.ok || response.body === null) {
      await response.text().catch(() => "");
      result.totalMs = elapsed();
      return result;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let name = "";
    let args = "";
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const parsed = ChunkSchema.safeParse(json);
        if (!parsed.success) continue;
        for (const choice of parsed.data.choices ?? []) {
          const delta = choice.delta;
          const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? "";
          const content = delta?.content ?? "";
          const calls = delta?.tool_calls ?? [];
          if (result.firstTokenMs === null && (reasoning !== "" || content !== "" || calls.length))
            result.firstTokenMs = elapsed();
          if (result.firstContentMs === null && (content !== "" || calls.length > 0))
            result.firstContentMs = elapsed();
          for (const call of calls) {
            name += call.function?.name ?? "";
            args += call.function?.arguments ?? "";
          }
          if (choice.finish_reason) result.finish = choice.finish_reason;
        }
      }
    }
    if (name !== "") {
      let city = "";
      try {
        city = z.object({ city: z.string() }).parse(JSON.parse(args)).city;
      } catch {
        city = "";
      }
      result.toolCall = name === "get_weather" && /paris/i.test(city) ? "correct" : "wrong";
    }
  } catch (error) {
    if (controller.signal.aborted) result.status = "timeout";
    else result.finish = redact(error instanceof Error ? error.message : "error").slice(0, 60);
  } finally {
    clearTimeout(timer);
  }
  result.totalMs = elapsed();
  return result;
}

function cell(value: number | null): string {
  return value === null ? "-" : `${(value / 1000).toFixed(1)}s`;
}

it("probes NVIDIA catalog chat models for latency and tool calling", async () => {
  const env = loadRepoEnv();
  const apiKey = env.NVIDIA_API_KEY ?? "";
  expect(apiKey, "NVIDIA_API_KEY must be set in .env.local").not.toBe("");
  const listResponse = await fetch(`${BASE_URL}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(listResponse.status).toBe(200);
  const ids = ModelListSchema.parse(await listResponse.json()).data.map((model) => model.id);
  const extra = (process.env.NVIDIA_PROBE_EXTRA ?? "").split(",").filter((id) => id !== "");
  const only = process.env.NVIDIA_PROBE_ONLY === "1";
  const candidates = [...new Set([...extra, ...(only ? [] : rankCandidates(ids))])].slice(
    0,
    MAX_PROBES,
  );
  process.stdout.write(`\ncatalog: ${ids.length} models; probing ${candidates.length}\n`);
  process.stdout.write(`${[...ids].sort().join("\n")}\n`);
  const results: ProbeResult[] = [];
  for (const model of candidates) {
    const result = await probe(apiKey, model);
    results.push(result);
    process.stdout.write(
      `${redact(
        [
          model,
          String(result.status),
          cell(result.ttfbMs),
          cell(result.firstTokenMs),
          cell(result.firstContentMs),
          cell(result.totalMs),
          result.toolCall,
          result.finish,
        ].join(" | "),
      )}\n`,
    );
    await sleep(GAP_MS);
  }
  process.stdout.write(
    `\n| model | status | ttfb | first token | first content/tool | total | tool call | finish |\n|---|---|---|---|---|---|---|---|\n`,
  );
  for (const r of results) {
    process.stdout.write(
      `${redact(`| ${r.model} | ${String(r.status)} | ${cell(r.ttfbMs)} | ${cell(r.firstTokenMs)} | ${cell(r.firstContentMs)} | ${cell(r.totalMs)} | ${r.toolCall} | ${r.finish} |`)}\n`,
    );
  }
  expect(results.length).toBeGreaterThan(0);
});
