import { setupHarness, setupStep } from "@graft/db/schema/setup";
import { describe, expect, it } from "vitest";

import { readSetupHarness, SETUP_HARNESS_IDS, SETUP_HARNESSES, setupHarnessOf } from "./harness";
import { currentSetupStep, isAwaitingHarness, SETUP_STEPS, shouldShowSetup } from "./setup.rules";

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
      ["ChatGPT", "Web & desktop", "oauth"],
      ["Claude Code", "Terminal & IDE", "oauth"],
      ["Codex", "App, CLI & IDE", "oauth"],
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
});
