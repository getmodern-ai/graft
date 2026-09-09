import { DAY_MS, promoteTool, type ServiceContext } from "@graft/core";
import {
  createInFlightRegistry,
  createToolListChangedNotifier,
  type McpDeps,
  runSweep,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore } from "@graft/mcp/testing/fake-deps";
import { initLogger } from "evlog";
import { describe, expect, it } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * GRA-24's acceptance criterion at the wire: a demotion the sweep makes is a change the console's
 * history route reads back with its cause. The MCP deps and the JSON API share one fake store, as
 * the server shares one database, so what the rule wrote is what the person's route answers.
 */

initLogger({ silent: true });

describe("a sweep's demotion reads back through the working-set history route", () => {
  it("records the cause the console shows, under the person, with the tool named", async () => {
    let clock = new Date("2026-09-01T09:00:00Z");
    const store = createFakeStore({ now: () => clock });
    store.addAgent({ id: "agent_a", personId: "person_1", token: "grft_a_000000000000000000" });
    store.addAgent({ id: "agent_b", personId: "person_2", token: "grft_b_000000000000000000" });
    store.addTool({
      id: "tool_1",
      personId: "person_1",
      vendor: "demo",
      name: "list-orders",
      description: "Lists orders",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      destructive: false,
      defaultConnectionId: null,
      path: "tools/demo/list-orders/v1",
    });
    const fake = createFakeDeps(store);
    const ctx: ServiceContext = { db: fake.db };
    await promoteTool(
      ctx,
      { personId: "person_1", agentId: "agent_a" },
      "tool_1",
      "agent",
      fake.workingSet,
    );

    const notifier = createToolListChangedNotifier({ windowMs: 50 });
    const inFlight = createInFlightRegistry();
    const mcp: McpDeps = {
      ...fake,
      sandbox: null,
      keys: null,
      proxyPublicUrl: "http://localhost:3000/api/proxy",
      checkModule: async () => ({
        entry: null,
        refusals: [],
        advice: [],
        annotations: { readOnly: true, destructive: false },
      }),
      runnerFiles: async () => [],
      skills: async () => [],
      readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
      notifier,
      inFlight,
      now: () => clock,
      handoff: {
        consoleUrl: "http://console.graft.test",
        secret: "graft-server-sweep-test-handoff-secret-long-enough",
        waitMs: 0,
        ttlMs: 60_000,
      },
    };
    let sessionPerson = "person_1";
    const app = createServer({
      keys: null,
      vault: { decrypt: async () => ({}) },
      connections: { get: async () => null },
      followRedirects: false,
      api: {
        auth: {
          handler: async () => new Response("auth"),
          getSession: async () => ({ user: { id: sessionPerson } }),
        },
        deps: {
          db: fake.db,
          agent: fake.agent,
          connection: fake.connection,
          workingSet: fake.workingSet,
          tool: fake.tool,
          ledger: fake.ledger,
          approval: fake.approval,
          pendingAction: fake.pendingAction,
          modelKey: fakeModelKeyDeps(),
        },
        corsOrigins: [],
        handoff: mcp.handoff,
      },
      mcp,
    });

    try {
      clock = new Date(clock.getTime() + 22 * DAY_MS);
      const report = await runSweep(ctx, mcp, clock);
      expect(report.demoted).toEqual([{ agentId: "agent_a", toolId: "tool_1", cause: "idle" }]);

      const res = await app.request("/api/agents/agent_a/working-set/changes");
      expect(res.status).toBe(200);
      const tool = {
        id: "tool_1",
        vendor: "demo",
        name: "list-orders",
        description: "Lists orders",
      };
      expect(await res.json()).toEqual({
        changes: [
          {
            id: expect.any(String),
            change: "demote",
            cause: "idle",
            createdAt: clock.toISOString(),
            tool,
          },
          {
            id: expect.any(String),
            change: "promote",
            cause: "agent",
            createdAt: "2026-09-01T09:00:00.000Z",
            tool,
          },
        ],
      });

      // Another person's session sees no such agent (ADR 0007).
      sessionPerson = "person_2";
      const theirs = await app.request("/api/agents/agent_a/working-set/changes");
      expect(theirs.status).toBe(404);
    } finally {
      notifier.close();
      inFlight.close();
    }
  });
});
