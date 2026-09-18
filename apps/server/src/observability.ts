import {
  type Analytics,
  createPostHogAnalytics,
  DEFAULT_POSTHOG_HOST,
  NO_ANALYTICS,
} from "@graft/analytics";
import type { ServerEnv } from "@graft/env/server";
import type { DrainContext, DrainFn } from "evlog";
import { createAxiomDrain } from "evlog/axiom";
import { createDrainPipeline } from "evlog/pipeline";

import type { AnalyticsConfig } from "./api";

/**
 * Everything the process starts for observability and everything it must flush before it exits —
 * GRA-100, in the shape of Cando's `observability.ts` and `log-drain.ts` (ADR 0011). Called first
 * thing in `index.ts`, because the drain it returns is what `initLogger` is handed. Two tools, each
 * off until its variables arrive, so an unconfigured process — every laptop, CI, a self-host that
 * set neither — starts and stops exactly as it did before this file.
 *
 * **Axiom** is where a wide event goes after stdout. Until this existed a wide event lived exactly
 * as long as the stdout line it was printed on: greppable in the container's log, not queryable.
 * evlog's Axiom adapter behind evlog's own pipeline, which batches, retries and bounds the buffer so
 * a slow ingest endpoint costs memory rather than request latency; over the bound the oldest event
 * is dropped and `onDropped` says so — on stdout, which still has every event. Handed to
 * `initLogger({ drain })` rather than to the Hono middleware's `evlog({ drain })`, and the
 * difference is which events arrive: the middleware option drains HTTP requests only, the global
 * drain is what the process's own `log` calls fall back to — the acquire runner's and the sweep's
 * lines — and the middleware's events reach the global drain too (`getGlobalDrain` in evlog's Hono
 * adapter), so one registration covers both. The adapter would read `AXIOM_API_KEY` off
 * `process.env` itself; the values are passed so `@graft/env` is the one place their shape is
 * decided, and the names are `GRAFT_*` like every other.
 *
 * **PostHog** is the analytics seam's one backing (`@graft/analytics`). The server captures what
 * happens over MCP and never in a browser — a tool call, a job's end — and hands the console the
 * same key through `GET /api/analytics` (`consoleAnalytics`), so both halves of a person's story
 * land on one profile. The key is public by design: every browser that loads the console is given
 * it, which is why it rides the environment rather than a build.
 */

export type ObservabilityEnv = Pick<
  ServerEnv,
  | "GRAFT_AXIOM_API_KEY"
  | "GRAFT_AXIOM_DATASET"
  | "GRAFT_AXIOM_URL"
  | "GRAFT_POSTHOG_KEY"
  | "GRAFT_POSTHOG_HOST"
>;

export type Observability = {
  /** What `initLogger` is handed; null leaves evlog exactly as it was. */
  drain: DrainFn | null;
  /** What the server captures through; `NO_ANALYTICS` when no key is set. */
  analytics: Analytics;
  /** What `GET /api/analytics` answers — the console's half of the same setting. */
  consoleAnalytics: AnalyticsConfig;
  /** Two clauses for the boot line: `logs …`, `analytics …`. */
  summary: string;
  /**
   * Deliver what is buffered, bounded: a stop is ECS's `SIGTERM` with thirty seconds before
   * `SIGKILL`, and an ingest endpoint that is down should cost a few of those, not all of them.
   * Rejections are settled, never thrown — a flush is best effort.
   */
  flush(withinMs: number): Promise<void>;
};

export type StartObservabilityInput = {
  env: ObservabilityEnv;
  /** Test seams: a stand-in for the PostHog client, and the pipeline's clocks lowered. */
  analyticsFactory?: typeof createPostHogAnalytics;
  batchIntervalMs?: number;
};

/** The pipeline's bound. Five thousand rather than the default thousand: an `/mcp` event carrying a run's answer is large. */
export const DRAIN_BUFFER_SIZE = 5_000;

export function startObservability(input: StartObservabilityInput): Observability {
  const { env } = input;

  let drain: ReturnType<ReturnType<typeof createDrainPipeline<DrainContext>>> | null = null;
  if (env.GRAFT_AXIOM_API_KEY && env.GRAFT_AXIOM_DATASET) {
    const pipeline = createDrainPipeline<DrainContext>({
      batch: { size: 50, intervalMs: input.batchIntervalMs ?? 5_000 },
      maxBufferSize: DRAIN_BUFFER_SIZE,
      onDropped: (events, error) => {
        console.error(
          `[log-drain] dropped ${events.length} wide events: ${error?.message ?? "buffer overflow"}`,
        );
      },
    });
    drain = pipeline(
      createAxiomDrain({
        apiKey: env.GRAFT_AXIOM_API_KEY,
        dataset: env.GRAFT_AXIOM_DATASET,
        // Only when the organisation is not on Axiom's default region — see `GRAFT_AXIOM_URL` in the schema.
        ...(env.GRAFT_AXIOM_URL ? { baseUrl: env.GRAFT_AXIOM_URL } : {}),
      }),
    );
  }

  const posthog = env.GRAFT_POSTHOG_KEY
    ? { key: env.GRAFT_POSTHOG_KEY, host: env.GRAFT_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST }
    : null;
  const analytics = posthog
    ? (input.analyticsFactory ?? createPostHogAnalytics)({ key: posthog.key, host: posthog.host })
    : NO_ANALYTICS;

  return {
    drain,
    analytics,
    consoleAnalytics: { posthog },
    summary:
      `logs ${drain ? `stdout and axiom (${env.GRAFT_AXIOM_DATASET})` : "stdout"}, ` +
      `analytics ${analytics.name}`,
    flush: (withinMs) =>
      within(
        withinMs,
        Promise.allSettled([drain?.flush(), analytics.shutdown()]).then(() => undefined),
      ),
  };
}

function within(ms: number, work: Promise<void>): Promise<void> {
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
  return Promise.race([work, deadline]);
}
