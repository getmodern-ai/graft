import type { AnalyticsEvent, AnalyticsProperties } from "./events";

/**
 * The seam the server captures through (GRA-100), so a call site knows nothing of PostHog and a
 * test stands a recorder in its place. One real backing, `./posthog.ts`, switched on by
 * `GRAFT_POSTHOG_KEY`; `NO_ANALYTICS` is what an unconfigured deployment and every unit test run
 * with, and under it a capture is nothing at all. Mail, the model's telemetry and this are the same
 * shape (ADR 0002): a plain interface, a backing chosen at boot, a no-op that is exactly the absence
 * of the feature.
 */

export type Capture = {
  /** The person the event belongs to — their id, never their email (`events.ts`). */
  distinctId: string;
  event: AnalyticsEvent;
  properties?: AnalyticsProperties;
};

export type Analytics = {
  /** The name the boot line carries — `posthog`, or `off`. */
  name: string;
  /** Fire and forget: a capture never throws and never blocks the call that made it. */
  capture(input: Capture): void;
  /** Deliver everything buffered. Call before the process exits, or the last events are lost. */
  shutdown(): Promise<void>;
};

export const NO_ANALYTICS: Analytics = {
  name: "off",
  capture: () => undefined,
  shutdown: async () => undefined,
};
