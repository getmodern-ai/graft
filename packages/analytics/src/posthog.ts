import { PostHog } from "posthog-node";

import type { Analytics } from "./analytics";

/** PostHog's default ingestion host — the US cloud; `GRAFT_POSTHOG_HOST` names another region or a self-hosted instance. */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export type PostHogAnalyticsConfig = {
  /** The project API key, `phc_…` — public by design, the same one the console is handed. */
  key: string;
  /** The ingestion host; `DEFAULT_POSTHOG_HOST` when absent. */
  host?: string | null;
  /** How many events the client buffers before it posts, and how long one may wait. The SDK's defaults otherwise. */
  flushAt?: number;
  flushInterval?: number;
  /** Where a delivery failure is reported; the SDK never throws one. `console.error` by default. */
  onError?: (error: unknown) => void;
};

/**
 * The PostHog backing of the analytics seam (GRA-100): `posthog-node`'s client, which batches in
 * memory and posts to `/batch/` on the host, retrying on its own. A delivery failure is reported
 * through `onError` and nowhere else — the SDK is fire-and-forget by design, and the alternative,
 * an unhandled rejection from inside a tool call, would turn an analytics outage into a product
 * one. Every event names the person (`distinctId`), so PostHog files it on the same profile the
 * console's `identify` made.
 */
export function createPostHogAnalytics(config: PostHogAnalyticsConfig): Analytics {
  const report = config.onError ?? ((error) => console.error("[analytics] posthog:", error));
  const client = new PostHog(config.key, {
    host: config.host ?? DEFAULT_POSTHOG_HOST,
    ...(config.flushAt !== undefined ? { flushAt: config.flushAt } : {}),
    ...(config.flushInterval !== undefined ? { flushInterval: config.flushInterval } : {}),
  });
  client.on("error", report);
  return {
    name: "posthog",
    capture: (input) => {
      client.capture({
        distinctId: input.distinctId,
        event: input.event,
        ...(input.properties ? { properties: input.properties } : {}),
      });
    },
    shutdown: () => client.shutdown(),
  };
}
