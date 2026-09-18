import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Analytics } from "@graft/analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startObservability } from "./observability";

/**
 * The two tools through the seam: an Axiom on a loopback port receives what the drain sends, a
 * recorder stands in for PostHog, and the unconfigured process is asserted to start nothing.
 */

type Ingest = { path: string; auth: string | undefined; events: Array<Record<string, unknown>> };

let server: Server;
let baseUrl: string;
const ingests: Ingest[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      ingests.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        events: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<
          Record<string, unknown>
        >,
      });
      res.writeHead(200, { "content-type": "application/json" }).end('{"ingested":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const OFF = {
  GRAFT_AXIOM_API_KEY: undefined,
  GRAFT_AXIOM_DATASET: undefined,
  GRAFT_AXIOM_URL: undefined,
  GRAFT_POSTHOG_KEY: undefined,
  GRAFT_POSTHOG_HOST: undefined,
};

describe("startObservability", () => {
  it("starts nothing when nothing is set: no drain, analytics off, the console told so", async () => {
    const observability = startObservability({ env: OFF });
    expect(observability.drain).toBeNull();
    expect(observability.analytics.name).toBe("off");
    expect(observability.consoleAnalytics).toEqual({ posthog: null });
    expect(observability.summary).toBe("logs stdout, analytics off");
    await expect(observability.flush(100)).resolves.toBeUndefined();
  });

  it("drains a wide event into the named dataset under the key, on flush", async () => {
    const observability = startObservability({
      env: {
        ...OFF,
        GRAFT_AXIOM_API_KEY: "xaat-test",
        GRAFT_AXIOM_DATASET: "graft-test",
        GRAFT_AXIOM_URL: baseUrl,
      },
      batchIntervalMs: 60_000,
    });
    expect(observability.summary).toBe("logs stdout and axiom (graft-test), analytics off");
    observability.drain?.({
      event: {
        timestamp: "2026-09-18T00:00:00.000Z",
        level: "info",
        service: "graft-server",
        environment: "test",
        method: "POST",
        path: "/mcp",
        mcp: { tool: "find_tool", outcome: "ok" },
      },
      request: { method: "POST", path: "/mcp" },
    });
    await observability.flush(5_000);

    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.path).toMatch(/^\/v1\/datasets\/graft-test\/ingest/);
    expect(ingests[0]?.auth).toBe("Bearer xaat-test");
    expect(ingests[0]?.events[0]).toMatchObject({
      path: "/mcp",
      mcp: { tool: "find_tool", outcome: "ok" },
    });
  });

  it("builds the analytics backing from the key, the host defaulted, and hands the console the same pair", async () => {
    const built: Array<{ key: string; host?: string | null }> = [];
    let shutDown = 0;
    const fake: Analytics = {
      name: "posthog",
      capture: () => undefined,
      shutdown: async () => {
        shutDown += 1;
      },
    };
    const observability = startObservability({
      env: { ...OFF, GRAFT_POSTHOG_KEY: "phc_test" },
      analyticsFactory: (config) => {
        built.push(config);
        return fake;
      },
    });
    expect(built).toEqual([{ key: "phc_test", host: "https://us.i.posthog.com" }]);
    expect(observability.consoleAnalytics).toEqual({
      posthog: { key: "phc_test", host: "https://us.i.posthog.com" },
    });
    expect(observability.summary).toBe("logs stdout, analytics posthog");
    await observability.flush(1_000);
    expect(shutDown).toBe(1);

    const eu = startObservability({
      env: {
        ...OFF,
        GRAFT_POSTHOG_KEY: "phc_test",
        GRAFT_POSTHOG_HOST: "https://eu.i.posthog.com",
      },
      analyticsFactory: () => fake,
    });
    expect(eu.consoleAnalytics.posthog?.host).toBe("https://eu.i.posthog.com");
  });

  it("bounds the flush: a backing that never settles does not hold the stop", async () => {
    const observability = startObservability({
      env: { ...OFF, GRAFT_POSTHOG_KEY: "phc_test" },
      analyticsFactory: () => ({
        name: "posthog",
        capture: () => undefined,
        shutdown: () => new Promise<void>(() => undefined),
      }),
    });
    const started = Date.now();
    await observability.flush(50);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
