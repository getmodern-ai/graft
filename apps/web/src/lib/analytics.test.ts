import { describe, expect, it } from "vitest";

import { type AnalyticsClient, createAnalytics } from "./analytics";

/**
 * The queue in front of PostHog (GRA-100): a call made before the server has answered
 * `/api/analytics` is delivered once it has, in order; with analytics off every call is nothing;
 * a chunk that fails to load leaves a retry possible and the queue intact.
 */

function recorder() {
  const calls: string[] = [];
  const client: AnalyticsClient = {
    identify: ((id: string) => {
      calls.push(`identify ${id}`);
    }) as AnalyticsClient["identify"],
    reset: (() => {
      calls.push("reset");
    }) as AnalyticsClient["reset"],
    capture: ((event: string) => {
      calls.push(`capture ${event}`);
      return undefined;
    }) as AnalyticsClient["capture"],
  };
  return { calls, client };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ON = { posthog: { key: "phc_test", host: "https://us.i.posthog.com" } };

describe("createAnalytics", () => {
  it("delivers an identify made before init once the client is loaded, in order", async () => {
    const { calls, client } = recorder();
    const loaded: Array<{ key: string; host: string }> = [];
    const analytics = createAnalytics(async (config) => {
      loaded.push(config);
      return client;
    });
    analytics.identify("person_1");
    analytics.trackMutationSuccess(["agent", "create"]);
    await settled();
    expect(calls).toEqual([]);

    analytics.init(ON);
    await settled();
    expect(loaded).toEqual([ON.posthog]);
    expect(calls).toEqual(["identify person_1", "capture agent_created"]);

    analytics.reset();
    await settled();
    expect(calls.at(-1)).toBe("reset");
  });

  it("is nothing at all when the server says analytics is off, and loads no chunk", async () => {
    let loads = 0;
    const analytics = createAnalytics(async () => {
      loads += 1;
      return recorder().client;
    });
    analytics.identify("person_1");
    analytics.init({ posthog: null });
    analytics.track("agent_revoked");
    await settled();
    expect(loads).toBe(0);
  });

  it("inits once — a second answer changes nothing", async () => {
    let loads = 0;
    const analytics = createAnalytics(async () => {
      loads += 1;
      return recorder().client;
    });
    analytics.init(ON);
    analytics.init(ON);
    await settled();
    expect(loads).toBe(1);
  });

  it("keeps the queue and allows a retry when the chunk fails to load", async () => {
    const { calls, client } = recorder();
    let attempt = 0;
    const analytics = createAnalytics(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("chunk failed");
      return client;
    });
    analytics.identify("person_1");
    analytics.init(ON);
    await settled();
    expect(calls).toEqual([]);

    analytics.init(ON);
    await settled();
    expect(attempt).toBe(2);
    expect(calls).toEqual(["identify person_1"]);
  });

  it("ignores a mutation nobody charts", async () => {
    const { calls, client } = recorder();
    const analytics = createAnalytics(async () => client);
    analytics.init(ON);
    analytics.trackMutationSuccess(["agent", "rename"]);
    analytics.trackMutationSuccess(undefined);
    await settled();
    expect(calls).toEqual([]);
  });
});
