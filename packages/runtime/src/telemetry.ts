import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { ATTR_ERROR_TYPE, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { type TokenUsage } from "./providers/types";

export const GEN_AI_ATTRIBUTES = {
  operationName: "gen_ai.operation.name",
  requestModel: "gen_ai.request.model",
  requestMaxTokens: "gen_ai.request.max_tokens",
  providerName: "gen_ai.provider.name",
  system: "gen_ai.system",
  responseModel: "gen_ai.response.model",
  responseFinishReasons: "gen_ai.response.finish_reasons",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  usageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  usageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
  toolName: "gen_ai.tool.name",
} as const;

export const GEN_AI_INCUBATING_CONSTANTS: Record<keyof typeof GEN_AI_ATTRIBUTES, string> = {
  operationName: "ATTR_GEN_AI_OPERATION_NAME",
  requestModel: "ATTR_GEN_AI_REQUEST_MODEL",
  requestMaxTokens: "ATTR_GEN_AI_REQUEST_MAX_TOKENS",
  providerName: "ATTR_GEN_AI_PROVIDER_NAME",
  system: "ATTR_GEN_AI_SYSTEM",
  responseModel: "ATTR_GEN_AI_RESPONSE_MODEL",
  responseFinishReasons: "ATTR_GEN_AI_RESPONSE_FINISH_REASONS",
  usageInputTokens: "ATTR_GEN_AI_USAGE_INPUT_TOKENS",
  usageOutputTokens: "ATTR_GEN_AI_USAGE_OUTPUT_TOKENS",
  usageCacheReadInputTokens: "ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS",
  usageCacheCreationInputTokens: "ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS",
  toolName: "ATTR_GEN_AI_TOOL_NAME",
};

export const DELEGATE_ATTRIBUTES = {
  runId: "delegate.run_id",
  stepId: "delegate.step_id",
  agentId: "delegate.agent_id",
} as const;

export type GenAiOperation =
  "chat" | "execute_tool" | "invoke_agent" | "invoke_workflow" | "retrieval" | "embeddings";

export interface TelemetryOptions {
  serviceName?: string;
  exporter?: SpanExporter;
  otlpEndpoint?: string | undefined;
  register?: boolean;
}

export interface Telemetry {
  provider: TracerProvider;
  tracer: Tracer;
  exporting: "otlp" | "custom" | "none";
  shutdown(): Promise<void>;
}

export const TRACER_NAME = "@delegate/runtime";

export function setupTelemetry(options: TelemetryOptions = {}): Telemetry {
  const endpoint =
    "otlpEndpoint" in options ? options.otlpEndpoint : process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const processors: SpanProcessor[] = [];
  let exporting: Telemetry["exporting"] = "none";
  if (options.exporter !== undefined) {
    processors.push(new SimpleSpanProcessor({ exporter: options.exporter }));
    exporting = "custom";
  } else if (endpoint !== undefined && endpoint.trim() !== "") {
    const url = `${endpoint.trim().replace(/\/+$/, "")}/v1/traces`;
    processors.push(new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url }) }));
    exporting = "otlp";
  }

  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName ?? "delegate" }),
    spanProcessors: processors,
  });

  const register = options.register ?? true;
  if (register) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  }

  return {
    provider,
    tracer: provider.getTracer(TRACER_NAME),
    exporting,
    async shutdown() {
      await provider.shutdown();
      if (register) {
        trace.disable();
        context.disable();
      }
    },
  };
}

export interface GenAiSpanAttributes {
  operation: GenAiOperation;
  model?: string;
  provider?: string;
  maxTokens?: number;
  toolName?: string;
  runId?: string;
  stepId?: string;
  agentId?: string;
}

export interface GenAiSpan {
  readonly span: Span;
  setUsage(usage: TokenUsage): void;
  setResponse(response: { model?: string; finishReason?: string }): void;
}

function requestAttributes(attrs: GenAiSpanAttributes): Attributes {
  const out: Attributes = { [GEN_AI_ATTRIBUTES.operationName]: attrs.operation };
  if (attrs.model !== undefined) out[GEN_AI_ATTRIBUTES.requestModel] = attrs.model;
  if (attrs.provider !== undefined) {
    out[GEN_AI_ATTRIBUTES.providerName] = attrs.provider;
    out[GEN_AI_ATTRIBUTES.system] = attrs.provider;
  }
  if (attrs.maxTokens !== undefined) out[GEN_AI_ATTRIBUTES.requestMaxTokens] = attrs.maxTokens;
  if (attrs.toolName !== undefined) out[GEN_AI_ATTRIBUTES.toolName] = attrs.toolName;
  if (attrs.runId !== undefined) out[DELEGATE_ATTRIBUTES.runId] = attrs.runId;
  if (attrs.stepId !== undefined) out[DELEGATE_ATTRIBUTES.stepId] = attrs.stepId;
  if (attrs.agentId !== undefined) out[DELEGATE_ATTRIBUTES.agentId] = attrs.agentId;
  return out;
}

export async function withGenAiSpan<T>(
  name: string,
  attrs: GenAiSpanAttributes,
  fn: (span: GenAiSpan) => Promise<T>,
  tracer: Tracer = trace.getTracer(TRACER_NAME),
): Promise<T> {
  const kind =
    attrs.operation === "chat" || attrs.operation === "embeddings"
      ? SpanKind.CLIENT
      : SpanKind.INTERNAL;
  return tracer.startActiveSpan(
    name,
    { kind, attributes: requestAttributes(attrs) },
    async (span) => {
      const handle: GenAiSpan = {
        span,
        setUsage(usage) {
          span.setAttributes({
            [GEN_AI_ATTRIBUTES.usageInputTokens]:
              usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
            [GEN_AI_ATTRIBUTES.usageOutputTokens]: usage.outputTokens,
            [GEN_AI_ATTRIBUTES.usageCacheReadInputTokens]: usage.cacheReadTokens,
            [GEN_AI_ATTRIBUTES.usageCacheCreationInputTokens]: usage.cacheWriteTokens,
          });
        },
        setResponse(response) {
          if (response.model !== undefined)
            span.setAttribute(GEN_AI_ATTRIBUTES.responseModel, response.model);
          if (response.finishReason !== undefined) {
            span.setAttribute(GEN_AI_ATTRIBUTES.responseFinishReasons, [response.finishReason]);
          }
        },
      };
      try {
        return await fn(handle);
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.recordException(exception);
        span.setAttribute(ATTR_ERROR_TYPE, exception.name);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
