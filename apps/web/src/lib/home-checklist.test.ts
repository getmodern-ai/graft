import { describe, expect, it } from "vitest";

import type { AgentListItem } from "./agent-queries";
import {
  agentStepAction,
  askPromptTarget,
  checklistProgress,
  goodFirstIntegrations,
  homeChecklist,
  homeView,
  offersResumeSetup,
  tryLine,
} from "./home-checklist";
import type { SetupStateData, SetupVendor } from "./setup-queries";

/** Home's *Get started* checklist (GRA-328): the steps, the view, and the actions. */

const at = "2026-10-14T00:00:00.000Z";

const ready: AgentListItem = {
  id: "agent_1",
  name: "Claude",
  tokenPrefix: null,
  connectedVia: { clientId: "client_1", clientName: "Claude Code" },
  scopeMode: "all",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  createdAt: at,
  updatedAt: at,
  workingSetCount: 0,
  connectionIds: [],
  lastActiveAt: null,
};
const awaiting: AgentListItem = { ...ready, id: "agent_2", name: "Hermes", connectedVia: null };
const revoked: AgentListItem = { ...ready, id: "agent_3", name: "Old", revokedAt: at };

function setupState(
  overrides: Partial<NonNullable<SetupStateData["setup"]>> = {},
  agent: AgentListItem | null = awaiting,
): Pick<SetupStateData, "setup" | "agent"> {
  return {
    agent,
    setup: {
      step: "vendor",
      harness: "hermes",
      agentId: agent?.id ?? null,
      starterId: null,
      goal: null,
      stockTool: null,
      pendingActionId: null,
      connectionId: null,
      acquireJobId: null,
      toolId: null,
      startedAt: at,
      completedAt: null,
      skippedAt: at,
      ...overrides,
    },
  } as Pick<SetupStateData, "setup" | "agent">;
}

const done = (checklist: ReturnType<typeof homeChecklist>) =>
  Object.fromEntries(checklist.steps.map((step) => [step.id, step.done]));

describe("homeChecklist", () => {
  it("has nothing done for a person with nothing", () => {
    const checklist = homeChecklist({ agents: [], hasRunTool: false, integrations: [] });
    expect(done(checklist)).toEqual({ agent: false, integration: false, ask: false });
    expect(checklist.done).toBe(0);
    expect(checklistProgress(checklist)).toBe("0 of 3 done");
  });

  it("does not count an agent awaiting its software, nor a revoked one", () => {
    const checklist = homeChecklist({
      agents: [awaiting, revoked],
      hasRunTool: false,
      integrations: [],
    });
    expect(done(checklist).agent).toBe(false);
    expect(
      done(homeChecklist({ agents: [ready], hasRunTool: false, integrations: [] })).agent,
    ).toBe(true);
  });

  it("counts any connection and a tool that ran", () => {
    const checklist = homeChecklist({ agents: [], hasRunTool: true, integrations: [{}] });
    expect(done(checklist)).toEqual({ agent: false, integration: true, ask: true });
    expect(checklistProgress(checklist)).toBe("2 of 3 done");
  });

  it("makes the first open step the primary one", () => {
    const primary = (checklist: ReturnType<typeof homeChecklist>) =>
      checklist.steps.filter((step) => step.primary).map((step) => step.id);
    expect(primary(homeChecklist({ agents: [], hasRunTool: false, integrations: [] }))).toEqual([
      "agent",
    ]);
    expect(
      primary(homeChecklist({ agents: [ready], hasRunTool: false, integrations: [] })),
    ).toEqual(["integration"]);
    expect(
      primary(homeChecklist({ agents: [ready], hasRunTool: true, integrations: [{}] })),
    ).toEqual([]);
  });
});

describe("homeView", () => {
  it("draws the normal Home while a read is not in, and once everything is done", () => {
    expect(homeView(null)).toBe("home");
    expect(homeView(homeChecklist({ agents: [ready], hasRunTool: true, integrations: [{}] }))).toBe(
      "home",
    );
  });

  it("draws the empty Home with none done and the checklist above the panels with some", () => {
    expect(homeView(homeChecklist({ agents: [], hasRunTool: false, integrations: [] }))).toBe(
      "start",
    );
    expect(homeView(homeChecklist({ agents: [], hasRunTool: false, integrations: [{}] }))).toBe(
      "partial",
    );
  });
});

describe("agentStepAction", () => {
  it("creates an agent when none awaits its software", () => {
    expect(agentStepAction([ready, revoked], undefined)).toEqual({ kind: "create" });
  });

  it("resumes Setup for the agent an unfinished Setup runs as", () => {
    expect(agentStepAction([awaiting], setupState())).toEqual({
      kind: "setup",
      agentId: awaiting.id,
    });
  });

  it("opens Connect an agent for any other agent awaiting its software", () => {
    expect(agentStepAction([awaiting], undefined)).toEqual({ kind: "dialog", agent: awaiting });
    expect(agentStepAction([awaiting], setupState({ completedAt: at }))).toEqual({
      kind: "dialog",
      agent: awaiting,
    });
  });
});

describe("askPromptTarget", () => {
  it("names a connected agent in its client's words", () => {
    expect(askPromptTarget([awaiting, ready], undefined)).toEqual({
      agentName: "Claude",
      harness: "claude-code",
    });
  });

  it("names an agent awaiting its software in the harness Setup recorded, else any client's", () => {
    expect(askPromptTarget([awaiting], setupState())).toEqual({
      agentName: "Hermes",
      harness: "hermes",
    });
    expect(askPromptTarget([awaiting], undefined)).toEqual({
      agentName: "Hermes",
      harness: "other",
    });
  });

  it("names no agent when the person has none active", () => {
    expect(askPromptTarget([revoked], undefined)).toEqual({ harness: "other" });
    expect(askPromptTarget([], setupState({ harness: "codex" }, null))).toEqual({
      harness: "codex",
    });
  });
});

describe("offersResumeSetup", () => {
  it("offers a Setup skipped and never completed", () => {
    expect(offersResumeSetup(setupState())).toBe(true);
    expect(offersResumeSetup(setupState({ completedAt: at }))).toBe(false);
    expect(offersResumeSetup(setupState({ skippedAt: null }))).toBe(false);
    expect(offersResumeSetup({ setup: null })).toBe(false);
    expect(offersResumeSetup(undefined)).toBe(false);
  });
});

describe("goodFirstIntegrations", () => {
  const option = (vendor: string, goal: string): SetupVendor =>
    ({
      starter: { id: vendor, vendor, displayName: vendor, goal },
      provider: "Example",
      connect: "link",
    }) as SetupVendor;

  it("keeps the server's order and leaves out what is connected", () => {
    const vendors = [option("gmail", "a"), option("slack", "b"), option("github", "c")];
    expect(
      goodFirstIntegrations(vendors, [{ vendor: "slack" }]).map((row) => row.starter.vendor),
    ).toEqual(["gmail", "github"]);
  });

  it("reads the curated task as the Try line", () => {
    expect(tryLine({ goal: "Show me my unread emails" })).toBe('Try: "Show me my unread emails"');
  });
});
