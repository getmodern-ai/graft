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
 * with analytics off never downloads the chunk. **Every call queues on one promise that settles
 * when the setting is known**: the `_auth` guard's `identify` on the first navigation runs before
 * `/api/analytics` has answered, and it must reach PostHog rather than be dropped, or the first
 * pageview and every event until the next navigation would sit on an anonymous browser rather than
 * the person. With the setting off the promise settles to nothing and the queued calls are that.
 * A chunk that fails to load leaves the state as it was before `initAnalytics`, so a later call may
 * try again; `main.tsx` makes one, and the degradation is a page load without analytics.
 *
 * The singleton rather than `PostHogProvider`, because the places identity changes are not
 * components: the `_auth` guard's `beforeLoad`, `signOutAndForget`, and the query client's
 * `MutationCache`. Pageviews need no call at all — the dated defaults capture one on every history
 * change, which is how TanStack Router navigates. Autocapture and session recording are off:
 * a connection's display name, a vendor host and a tool's name are element text on these screens,
 * and the vocabulary's rule is counts and kinds, never content (`@graft/analytics/events`).
 *
 * A factory over the loader so the queueing is tested with a recorder in PostHog's place
 * (`analytics.test.ts`); the module's exports are the one instance the console uses.
 */

export type AnalyticsClient = Pick<PostHog, "identify" | "reset" | "capture">;

export type LoadAnalytics = (posthog: { key: string; host: string }) => Promise<AnalyticsClient>;

const loadPostHog: LoadAnalytics = async ({ key, host }) => {
  const { default: posthog } = await import("posthog-js");
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
};

export function createAnalytics(load: LoadAnalytics) {
  let settle: (client: AnalyticsClient | null) => void = () => undefined;
  let client = new Promise<AnalyticsClient | null>((resolve) => {
    settle = resolve;
  });
  let initialised = false;

  const withClient = (use: (client: AnalyticsClient) => void): void => {
    void client.then((posthog) => {
      if (posthog) use(posthog);
    });
  };

  return {
    /** Told once per page load what the server answered; until then every call below waits. */
    init(config: AnalyticsConfig): void {
      if (initialised) return;
      initialised = true;
      if (!config.posthog) {
        settle(null);
        return;
      }
      load(config.posthog).then(settle, () => {
        // The chunk did not arrive: back to the state before `init`, so a retry can succeed and
        // whatever is queued waits for it rather than being dropped on the floor.
        initialised = false;
        const previous = settle;
        client = new Promise<AnalyticsClient | null>((resolve) => {
          settle = resolve;
        });
        client.then(previous);
      });
    },
    /**
     * Who is asking, as PostHog should know them: the person's id — never the email — which is the
     * `distinctId` the server's own captures name, so one profile carries both halves. The `_auth`
     * guard calls this on every navigation; `identify` with an unchanged id is a no-op in posthog-js.
     */
    identify(personId: string): void {
      withClient((posthog) => posthog.identify(personId));
    },
    /** Sign-out forgets the person as thoroughly as the query cache does — `signOutAndForget`. */
    reset(): void {
      withClient((posthog) => posthog.reset());
    },
    track(event: AnalyticsEvent, properties?: AnalyticsProperties): void {
      withClient((posthog) => posthog.capture(event, properties));
    },
    /** The `MutationCache` chokepoint — `analytics-events.ts` decides which mutations count. */
    trackMutationSuccess(mutationKey: MutationKey | undefined): void {
      const event = mutationEvent(mutationKey);
      if (event) this.track(event);
    },
  };
}

const analytics = createAnalytics(loadPostHog);

/** Off outright where there is no `window` — a test that imports this module in Node, say. */
export const initAnalytics = (config: AnalyticsConfig): void =>
  analytics.init(typeof window === "undefined" ? { posthog: null } : config);
export const identifyAnalytics = (personId: string): void => analytics.identify(personId);
export const resetAnalytics = (): void => analytics.reset();
export const trackEvent = (event: AnalyticsEvent, properties?: AnalyticsProperties): void =>
  analytics.track(event, properties);
export const trackMutationSuccess = (mutationKey: MutationKey | undefined): void =>
  analytics.trackMutationSuccess(mutationKey);
