import type { AnalyticsEvent, AnalyticsProperties } from "@graft/analytics/events";
import type { AnalyticsConfig } from "@graft/server/api";
import type { MutationKey } from "@tanstack/react-query";
import type { PostHog } from "posthog-js";

import { mutationEvent } from "./analytics-events";

/**
 * PostHog, behind one module — GRA-100, in the shape of Cando's `analytics.ts` (ADR 0011).
 *
 * Every call here is a no-op until `initAnalytics` has been told the server's setting
 * (`GET /api/analytics`, read once in `main.tsx`) and that setting names a key — which is what
 * makes the rest of the console free to call these unconditionally: a laptop, a self-host that set
 * no key and every Vitest run see nothing loaded. The setting comes from the running server rather
 * than the build because one image serves every deployment (`apps/server/Dockerfile`), and the
 * key is public by design, so handing it to the browser is what PostHog expects.
 *
 * `posthog-js` is imported lazily, on the first `initAnalytics` that turns it on, so a console
 * with analytics off never downloads the chunk. Calls that arrive before the import resolves —
 * the guard's `identify` on the first navigation — queue behind it in order, on one promise.
 *
 * The singleton rather than `PostHogProvider`, because the places identity changes are not
 * components: the `_auth` guard's `beforeLoad`, `signOutAndForget`, and the query client's
 * `MutationCache`. Pageviews need no call at all — the dated defaults capture one on every history
 * change, which is how TanStack Router navigates. Autocapture and session recording are off:
 * a connection's display name, a vendor host and a tool's name are element text on these screens,
 * and the vocabulary's rule is counts and kinds, never content (`@graft/analytics/events`).
 */

let enabled = false;
let client: Promise<PostHog | null> = Promise.resolve(null);

export function initAnalytics(config: AnalyticsConfig): void {
  if (enabled || typeof window === "undefined" || !config.posthog) return;
  const { key, host } = config.posthog;
  enabled = true;
  client = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: host,
        defaults: "2026-05-30",
        // A person is created at `identify`, never for an anonymous visitor: the two doors and the
        // reset screens are the only anonymous pages, and a visitor's events merge in on sign-in.
        person_profiles: "identified_only",
        autocapture: false,
        disable_session_recording: true,
        capture_exceptions: true,
      });
      return posthog;
    })
    .catch(() => null);
}

function withClient(use: (posthog: PostHog) => void): void {
  if (!enabled) return;
  void client.then((posthog) => {
    if (posthog) use(posthog);
  });
}

/**
 * Who is asking, as PostHog should know them: the person's id — never the email — which is the
 * `distinctId` the server's own captures name, so one profile carries both halves. The `_auth`
 * guard calls this on every navigation; `identify` with an unchanged id is a no-op in posthog-js.
 */
export function identifyAnalytics(personId: string): void {
  withClient((posthog) => posthog.identify(personId));
}

/** Sign-out forgets the person as thoroughly as the query cache does — `signOutAndForget`. */
export function resetAnalytics(): void {
  withClient((posthog) => posthog.reset());
}

export function trackEvent(event: AnalyticsEvent, properties?: AnalyticsProperties): void {
  withClient((posthog) => posthog.capture(event, properties));
}

/** The `MutationCache` chokepoint — `analytics-events.ts` decides which mutations count. */
export function trackMutationSuccess(mutationKey: MutationKey | undefined): void {
  const event = mutationEvent(mutationKey);
  if (event) trackEvent(event);
}
