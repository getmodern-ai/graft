import type { AnalyticsEvent, AnalyticsProperties } from "./events";

/**
 * The analytics seam (GRA-100; ADR 0002 as amended 2026-09-19): what the server captures product
 * events through, knowing nothing of any vendor. The open form has **no backing** — `NO_ANALYTICS`,
 * under which a capture is nothing at all, is what a self-host and every unit test run with — and
 * the hosted form's backing lives in the private package, answered as `Backings.analytics` beside
 * the sandbox, the keyring, the mirror and mail. The seam is the same shape as those: a plain
 * interface, a name for the boot line, a no-op that is exactly the absence of the feature.
 */

export type Capture = {
  /** The person the event belongs to — their id, never their email (`events.ts`). */
  distinctId: string;
  event: AnalyticsEvent;
  properties?: AnalyticsProperties;
  /**
   * Properties to set on the person's profile rather than on the event (GRA-157) — PostHog's
   * `$set`, in the backing's own spelling. Today the email, from `person_signed_up` alone
   * (`events.ts` says why); every other event leaves the profile as it is. The no-op ignores it.
   */
  person?: AnalyticsProperties;
};

export type Analytics = {
  /** The name the boot line carries — the backing's, or `off`. */
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
