import { setupHarness, setupStep } from "@graft/db/schema/setup";
import { describe, expect, it } from "vitest";

import { readSetupHarness, SETUP_HARNESS_IDS, SETUP_HARNESSES, setupHarnessOf } from "./harness";
import {
  currentSetupStep,
  isAwaitingHarness,
  previousSetupStep,
  SETUP_AGENT_PARAM,
  SETUP_PATH,
  SETUP_STEPS,
  setupBackTargets,
  setupStepReachable,
  setupUrl,
  shouldOfferSetup,
  shouldShowSetup,
  withoutTrailingSlashes,
} from "./setup.rules";

const AT = "2026-09-23T10:00:00.000Z";
const NONE = { connections: 0, tools: 0 };
const record = (
  clocks: Partial<{ startedAt: string; completedAt: string; skippedAt: string }>,
) => ({
  startedAt: clocks.startedAt ?? null,
  completedAt: clocks.completedAt ?? null,
  skippedAt: clocks.skippedAt ?? null,
});

describe("shouldShowSetup", () => {
  it("shows Setup to a person with no record and nothing done", () => {
    expect(shouldShowSetup(null, NONE)).toBe(true);
  });

  it("respects work done by hand: a connection or a tool and no record", () => {
    expect(shouldShowSetup(null, { connections: 1, tools: 0 })).toBe(false);
    expect(shouldShowSetup(null, { connections: 0, tools: 2 })).toBe(false);
  });

  it("keeps showing a started Setup whatever it has connected since", () => {
    expect(shouldShowSetup(record({ startedAt: AT }), { connections: 1, tools: 1 })).toBe(true);
  });

  it("reads a record that never started as no record", () => {
    expect(shouldShowSetup(record({}), NONE)).toBe(true);
    expect(shouldShowSetup(record({}), { connections: 1, tools: 0 })).toBe(false);
  });

  it("never shows a completed or skipped Setup", () => {
    expect(shouldShowSetup(record({ startedAt: AT, completedAt: AT }), NONE)).toBe(false);
    expect(shouldShowSetup(record({ skippedAt: AT }), NONE)).toBe(false);
    expect(shouldShowSetup(record({ startedAt: AT, skippedAt: AT }), NONE)).toBe(false);
  });

  it("takes a server Date as readily as the wire's string", () => {
    const at = new Date(AT);
    expect(shouldShowSetup({ startedAt: at, completedAt: at, skippedAt: null }, NONE)).toBe(false);
  });
});

describe("isAwaitingHarness", () => {
  const awaiting = { revokedAt: null, tokenPrefix: null, connectedVia: null };

  it("is an active agent with no token and no client", () => {
    expect(isAwaitingHarness(awaiting)).toBe(true);
  });

  it("ends once a token is issued or a consent names the agent", () => {
    expect(isAwaitingHarness({ ...awaiting, tokenPrefix: "grft_abc" })).toBe(false);
    expect(
      isAwaitingHarness({ ...awaiting, connectedVia: { clientId: "c_1", clientName: "Claude" } }),
    ).toBe(false);
  });

  it("is never a revoked agent", () => {
    expect(isAwaitingHarness({ ...awaiting, revokedAt: AT })).toBe(false);
    expect(isAwaitingHarness({ ...awaiting, revokedAt: new Date(AT) })).toBe(false);
  });
});

describe("shouldOfferSetup (find_tool's offer, GRA-210)", () => {
  it("offers Setup to a person with no connection and no record, or one under way", () => {
    expect(shouldOfferSetup(null, { connections: 0 })).toBe(true);
    expect(shouldOfferSetup(record({ startedAt: AT }), { connections: 0 })).toBe(true);
  });

  it("ends the offer at the first connection, a revoked one included", () => {
    expect(shouldOfferSetup(null, { connections: 1 })).toBe(false);
    expect(shouldOfferSetup(record({ startedAt: AT }), { connections: 1 })).toBe(false);
  });

  it("ends the offer once Setup is completed or skipped", () => {
    expect(shouldOfferSetup(record({ startedAt: AT, completedAt: AT }), NONE)).toBe(false);
    expect(shouldOfferSetup(record({ skippedAt: AT }), NONE)).toBe(false);
  });
});

describe("setupUrl", () => {
  it("is the console's Setup page naming the agent", () => {
    const url = new URL(setupUrl("http://console.graft.test", "agent_1"));
    expect(url.origin + url.pathname).toBe(`http://console.graft.test${SETUP_PATH}`);
    expect(url.searchParams.get(SETUP_AGENT_PARAM)).toBe("agent_1");
  });

  it("keeps the base's path and does not double its trailing slash", () => {
    expect(setupUrl("https://graft.example/console/", "a b")).toBe(
      "https://graft.example/console/setup?agent=a+b",
    );
  });

  it("trims a long run of trailing slashes in linear time, and nothing else", () => {
    expect(withoutTrailingSlashes("https://graft.example///")).toBe("https://graft.example");
    expect(withoutTrailingSlashes("///")).toBe("");
    expect(withoutTrailingSlashes("https://graft.example/a//b")).toBe("https://graft.example/a//b");
    const hostile = `https://graft.example/${"/".repeat(100_000)}x`;
    const started = performance.now();
    expect(setupUrl(hostile, "a")).toBe(`${hostile}/setup?agent=a`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("currentSetupStep", () => {
  it("is the harness step with no record, no agent, or an agent that no longer stands", () => {
    expect(currentSetupStep(null, false)).toBe("harness");
    expect(currentSetupStep({ step: "vendor", agentId: null }, false)).toBe("harness");
    expect(currentSetupStep({ step: "goal", agentId: "agent_1" }, false)).toBe("harness");
  });

  it("is the record's step while its agent stands", () => {
    expect(currentSetupStep({ step: "vendor", agentId: "agent_1" }, true)).toBe("vendor");
  });

  it("stays completed whatever became of the agent", () => {
    expect(currentSetupStep({ step: "completed", agentId: null }, false)).toBe("completed");
  });
});

describe("the vocabularies", () => {
  it("walks the steps the schema's column admits, in its order", () => {
    expect([...SETUP_STEPS]).toEqual([...setupStep]);
  });

  it("offers every harness the schema's column admits, and no other", () => {
    expect([...SETUP_HARNESS_IDS].sort()).toEqual([...setupHarness].sort());
  });

  it("offers the seven harnesses in the order the marketing site's picker does", () => {
    expect(SETUP_HARNESSES.map((entry) => [entry.label, entry.description, entry.kind])).toEqual([
      ["Claude", "Web & desktop", "oauth"],
      ["Claude Code", "Terminal & IDE", "oauth"],
      ["Codex", "App, CLI & IDE", "oauth"],
      ["ChatGPT", "Web & desktop", "oauth"],
      ["Hermes", "Local agent", "token"],
      ["OpenClaw", "Local agent", "token"],
      ["Other MCP agent", "Any compatible client", "token"],
    ]);
  });

  it("reads a harness id back, and nothing else", () => {
    expect(readSetupHarness("hermes")).toBe("hermes");
    expect(readSetupHarness("slack")).toBeNull();
    expect(readSetupHarness(undefined)).toBeNull();
    expect(setupHarnessOf("claude-code").agentName).toBe("Claude Code");
  });

  it("gives every harness its connection steps, in sentences without an em dash", () => {
    for (const entry of SETUP_HARNESSES) {
      expect(entry.steps.length).toBeGreaterThan(0);
      for (const step of entry.steps) {
        expect(step).toMatch(/\.$/);
        expect(step).not.toContain("\u2014");
      }
    }
  });
});

describe("where Setup can go back to (GRA-215)", () => {
  const held = {
    pendingActionId: null,
    connectionId: "conn_1",
    acquireJobId: "job_1",
    toolId: "tool_1",
  };

  it("offers every step before the record's that it holds what for, in order", () => {
    expect(setupBackTargets({ ...held, step: "finish" })).toEqual([
      "harness",
      "vendor",
      "connect",
      "goal",
      "building",
      "result",
    ]);
    expect(setupBackTargets({ ...held, step: "goal" })).toEqual(["harness", "vendor", "connect"]);
    expect(setupBackTargets({ ...held, step: "harness" })).toEqual([]);
    expect(setupBackTargets({ ...held, step: "completed" })).toEqual([]);
  });

  it("leaves out the result a record passed while the job ran, and a connect step it never held", () => {
    const continued = { ...held, toolId: null, step: "finish" as const };
    expect(setupBackTargets(continued)).not.toContain("result");
    expect(previousSetupStep(continued)).toBe("building");
    const asking = { ...held, connectionId: null, pendingActionId: "pa_1" };
    expect(setupStepReachable("connect", asking)).toBe(true);
    expect(setupStepReachable("goal", asking)).toBe(false);
    expect(setupStepReachable("connect", { ...asking, pendingActionId: null })).toBe(false);
  });

  it("names the step before as Back's, and none on the first", () => {
    expect(previousSetupStep({ ...held, step: "result" })).toBe("building");
    expect(previousSetupStep({ ...held, step: "vendor" })).toBe("harness");
    expect(previousSetupStep({ ...held, step: "harness" })).toBeNull();
    expect(setupStepReachable("finish", held)).toBe(false);
  });
});
