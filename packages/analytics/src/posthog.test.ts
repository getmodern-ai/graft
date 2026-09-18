import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NO_ANALYTICS } from "./analytics";
import { createPostHogAnalytics } from "./posthog";

/**
 * The PostHog backing against a PostHog on a loopback port: what leaves the process is asserted,
 * not what the SDK was asked. The fake answers `/batch/` and records the bodies — gzipped, as the
 * SDK sends them; a `shutdown` is what makes the SDK post what it buffered, which is the call the
 * server makes on `SIGTERM`.
 */

type Batch = { api_key: string; batch: Array<Record<string, unknown>> };

let server: Server;
let host: string;
const received: Batch[] = [];
let failNext = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (failNext) {
        failNext = false;
        res.writeHead(400).end("bad");
        return;
      }
      const raw = Buffer.concat(chunks);
      const body = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
      received.push(JSON.parse(body.toString("utf8")) as Batch);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createPostHogAnalytics", () => {
  it("posts every capture to /batch/ under the key, named for the person, and delivers on shutdown", async () => {
    const analytics = createPostHogAnalytics({
      key: "phc_test",
      host,
      flushAt: 10,
      flushInterval: 60_000,
    });
    expect(analytics.name).toBe("posthog");
    analytics.capture({
      distinctId: "person_1",
      event: "tool_called",
      properties: { tool: "find_tool", outcome: "ok", latency_ms: 12 },
    });
    analytics.capture({ distinctId: "person_1", event: "acquire_completed" });
    await analytics.shutdown();

    const events = received.flatMap((batch) => batch.batch);
    expect(received.every((batch) => batch.api_key === "phc_test")).toBe(true);
    expect(events.map((event) => [event.event, event.distinct_id])).toEqual([
      ["tool_called", "person_1"],
      ["acquire_completed", "person_1"],
    ]);
    expect(events[0]?.properties).toMatchObject({
      tool: "find_tool",
      outcome: "ok",
      latency_ms: 12,
    });
  });

  it("reports a refused batch through onError and never throws", async () => {
    const errors: unknown[] = [];
    const analytics = createPostHogAnalytics({
      key: "phc_test",
      host,
      flushAt: 1,
      flushInterval: 60_000,
      onError: (error) => errors.push(error),
    });
    failNext = true;
    analytics.capture({
      distinctId: "person_2",
      event: "acquire_failed",
      properties: { failure: "x" },
    });
    await analytics.shutdown();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("is a no-op under NO_ANALYTICS", async () => {
    expect(NO_ANALYTICS.name).toBe("off");
    NO_ANALYTICS.capture({ distinctId: "p", event: "agent_created" });
    await expect(NO_ANALYTICS.shutdown()).resolves.toBeUndefined();
  });
});
