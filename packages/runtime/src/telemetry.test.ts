import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import * as incubating from "@opentelemetry/semantic-conventions/incubating";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderHttpError } from "./providers/types";
import {
  GEN_AI_ATTRIBUTES,
  GEN_AI_INCUBATING_CONSTANTS,
  setupTelemetry,
  withGenAiSpan,
  type Telemetry,
} from "./telemetry";

let active: Telemetry | undefined;

afterEach(async () => {
  await active?.shutdown();
  active = undefined;
});

function start(options: Parameters<typeof setupTelemetry>[0]): Telemetry {
  active = setupTelemetry(options);
  return active;
}

describe("GenAI attribute names", () => {
  it("match @opentelemetry/semantic-conventions 1.45 incubating constants", () => {
    for (const [key, constantName] of Object.entries(GEN_AI_INCUBATING_CONSTANTS)) {
      expect(Reflect.get(incubating, constantName), constantName).toBe(
        GEN_AI_ATTRIBUTES[key as keyof typeof GEN_AI_ATTRIBUTES],
      );
    }
    expect(Object.keys(GEN_AI_INCUBATING_CONSTANTS).sort()).toEqual(
      Object.keys(GEN_AI_ATTRIBUTES).sort(),
    );
  });
});

describe("setupTelemetry", () => {
  it("exports nothing when no endpoint or exporter is configured", () => {
    expect(start({ register: false, otlpEndpoint: undefined }).exporting).toBe("none");
  });

  it("uses the OTLP HTTP exporter when an endpoint is configured", () => {
    expect(start({ register: false, otlpEndpoint: "http://localhost:4318" }).exporting).toBe(
      "otlp",
    );
  });
});

describe("withGenAiSpan", () => {
  it("records GenAI attributes and usage on a client span", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = start({ register: false, exporter, serviceName: "delegate-test" });

    const result = await withGenAiSpan(
      "chat gpt-oss-120b",
      {
        operation: "chat",
        model: "gpt-oss-120b",
        provider: "groq",
        maxTokens: 512,
        runId: "run_1",
        stepId: "s1",
      },
      (span) => {
        span.setResponse({ model: "openai/gpt-oss-120b", finishReason: "tool_use" });
        span.setUsage({
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheWriteTokens: 5,
        });
        return Promise.resolve("ok");
      },
      telemetry.tracer,
    );

    expect(result).toBe("ok");
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("chat gpt-oss-120b");
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.resource.attributes["service.name"]).toBe("delegate-test");
    expect(span?.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-oss-120b",
      "gen_ai.provider.name": "groq",
      "gen_ai.system": "groq",
      "gen_ai.request.max_tokens": 512,
      "gen_ai.response.model": "openai/gpt-oss-120b",
      "gen_ai.response.finish_reasons": ["tool_use"],
      "gen_ai.usage.input_tokens": 405,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 300,
      "gen_ai.usage.cache_creation.input_tokens": 5,
      "delegate.run_id": "run_1",
      "delegate.step_id": "s1",
    });
  });

  it("records tool spans with the tool name", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = start({ register: false, exporter });
    await withGenAiSpan(
      "execute_tool web_fetch",
      { operation: "execute_tool", toolName: "web_fetch" },
      () => Promise.resolve(),
      telemetry.tracer,
    );
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "web_fetch",
    });
    expect(exporter.getFinishedSpans()[0]?.kind).toBe(SpanKind.INTERNAL);
  });

  it("marks the span as an error and rethrows", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = start({ register: false, exporter });
    await expect(
      withGenAiSpan(
        "chat m",
        { operation: "chat", model: "m" },
        () => Promise.reject(new Error("boom")),
        telemetry.tracer,
      ),
    ).rejects.toThrow("boom");
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "boom" });
    expect(span?.events.map((event) => event.name)).toEqual(["exception"]);
    expect(span?.attributes["error.type"]).toBe("Error");
  });

  it("records provider HTTP errors by status only, never the response body", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = start({ register: false, exporter });
    await expect(
      withGenAiSpan(
        "chat m",
        { operation: "chat", model: "m", provider: "p" },
        () => Promise.reject(new ProviderHttpError("p", 503, "secret-body user prompt echo")),
        telemetry.tracer,
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes["http.response.status_code"]).toBe(503);
    expect(span?.attributes["error.type"]).toBe("ProviderHttpError");
    expect(span?.status.message).toBe("p: HTTP 503");
    expect(JSON.stringify([span?.events, span?.attributes, span?.status])).not.toContain(
      "secret-body",
    );
  });

  it("nests spans through the async context manager when registered globally", async () => {
    const exporter = new InMemorySpanExporter();
    start({ register: true, exporter });
    await withGenAiSpan("invoke_agent researcher", { operation: "invoke_agent" }, async () => {
      await withGenAiSpan("chat m", { operation: "chat", model: "m" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
    });
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === "invoke_agent researcher");
    const child = spans.find((span) => span.name === "chat m");
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });
});
