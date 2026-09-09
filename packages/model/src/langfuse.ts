import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { ModelCallTrace, ModelTelemetry } from "./telemetry";

/**
 * Langfuse, for every model call `acquire` makes — the one real binding of the `ModelTelemetry`
 * seam (`./telemetry.ts`), copied in shape from Cando's `packages/api/src/lib/langfuse.ts`
 * (ADR 0011), whose header carries the argument in full. The consequences that hold here:
 *
 * - **Passed per call, never registered globally.** A call that names its own `integrations`
 *   replaces the registered set, so a globally registered Langfuse would be silently dropped by any
 *   call that names another integration. The adapter spreads `telemetry.integrations` into each
 *   call instead.
 * - **Its own tracer provider, registered as the global one.** Registering installs the async
 *   context manager `propagateAttributes` needs to carry the job, person and attempt from `traced`
 *   down to spans the SDK starts later; without it the wrapper is a no-op that looks like it worked.
 *   Nothing else in the server registers a provider. The processor exports the `ai` scope only, so
 *   registering does not turn other spans in the process into Langfuse traffic.
 * - **Started only when configured.** `apps/server` calls this when the key pair is set
 *   (`GRAFT_LANGFUSE_PUBLIC_KEY`, `GRAFT_LANGFUSE_SECRET_KEY`); otherwise the adapter runs under
 *   `NO_TELEMETRY` and the SDK call is exactly what it was before this file.
 */

export type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  /** The region's host; undefined means the SDK's default, the EU cloud. */
  baseUrl?: string | null;
  /** Tags every trace with the deployment's environment — `NODE_ENV`. */
  environment?: string;
};

export type LangfuseHandle = {
  telemetry: ModelTelemetry;
  /** Export everything buffered. Call before the process exits, or the last job's trace is lost. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

/**
 * What a trace is called and what it carries, decided once here rather than at each call site.
 * The job is the session (Langfuse groups a session's traces in order, which is the whole
 * conversation of one `acquire`), the person is the user, and the provider, role and situation are
 * tags so a filter is one click. Every metadata value is a string, which is all
 * `propagateAttributes` carries — it drops anything else with a warning.
 */
export type TraceAttributes = {
  traceName: string;
  sessionId: string;
  userId: string;
  tags: string[];
  metadata: Record<string, string>;
};

export function acquireTraceAttributes(trace: ModelCallTrace): TraceAttributes {
  return {
    traceName: trace.role === "authoring" ? "acquire-authoring" : "acquire-triage",
    sessionId: trace.jobId,
    userId: trace.personId,
    tags: [trace.provider, trace.role, trace.situation],
    metadata: {
      jobId: trace.jobId,
      personId: trace.personId,
      attempt: String(trace.attempt),
      situation: trace.situation,
      role: trace.role,
      provider: trace.provider,
      modelId: trace.modelId,
    },
  };
}

export function createLangfuseTelemetry(config: LangfuseConfig): LangfuseHandle {
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.environment ? { environment: config.environment } : {}),
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();

  // The tracer is passed rather than looked up through the global API, so the integration is bound
  // to this provider whatever else registers one later.
  const integration = new LangfuseVercelAiSdkIntegration({ tracer: provider.getTracer("ai") });

  return {
    telemetry: {
      integrations: [integration],
      traced: (trace, fn) => propagateAttributes(acquireTraceAttributes(trace), fn),
    },
    flush: () => processor.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
