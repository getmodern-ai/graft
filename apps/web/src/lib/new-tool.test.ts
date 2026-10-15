import { describe, expect, it } from "vitest";

import type { ConnectionAccessView } from "./connection-queries";
import type { NewToolJob } from "./integration-queries";
import {
  buildingAgentId,
  buildingAgentLine,
  isNewToolJobWorking,
  newToolAgentChoices,
  newToolAttemptsLine,
  newToolConnectionId,
  newToolOf,
  newToolPartRows,
  newToolProgressFraction,
  newToolProgressNote,
  newToolPrompt,
  newToolReadyLine,
  newToolStep,
  runningNewToolJob,
  tryInAgents,
  tryInHint,
} from "./new-tool";
import { TOOL_ACCESS_CHIP, toolAccessChip } from "./status-chips";

type Row = ConnectionAccessView["agents"][number];

function row(id: string, inScope: boolean, lastUsedAt: string | null = null): Row {
  return {
    agent: { id, name: id.toUpperCase(), scopeMode: "all", connectedViaClientName: null },
    inScope,
    lastUsedAt,
    toolApprovals: [],
    vendorApproval: null,
    buildApproval: null,
  };
}

function access(connectionId: string, agents: Row[]): ConnectionAccessView {
  return { connectionId, vendor: "gmail", agents };
}

function job(overrides: Partial<NewToolJob> = {}): NewToolJob {
  return {
    jobId: "job_1",
    status: "running",
    progress: [],
    attempts: 1,
    connectionId: "c1",
    agent: { id: "a", name: "A", revoked: false },
    goal: "Find emails from a sender",
    createdAt: "2026-10-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("newToolAgentChoices", () => {
  it("offers only agents with a connected connection in scope, in agent order", () => {
    const choices = newToolAgentChoices(
      ["c1", "c2"],
      [
        access("c2", [row("a", true), row("b", true), row("c", false)]),
        access("c1", [
          row("a", false),
          row("b", true, "2026-10-01T00:00:00.000Z"),
          row("c", false),
        ]),
      ],
    );
    expect(choices.map((choice) => [choice.agent.id, choice.connectionIds])).toEqual([
      ["a", ["c2"]],
      ["b", ["c1", "c2"]],
    ]);
    expect(choices[1]?.lastUsedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("reaches nobody through a connection whose read has not answered", () => {
    expect(newToolAgentChoices(["c1"], [undefined])).toEqual([]);
  });
});

describe("buildingAgentLine", () => {
  it("says why the build runs as that agent", () => {
    expect(
      buildingAgentLine(
        { agent: { id: "a", name: "Hermes" }, lastUsedAt: "2026-10-01T00:00:00.000Z" },
        "Gmail",
      ),
    ).toBe(
      "Graft builds it as Hermes, the agent that last used Gmail. Creating it lets Hermes build Gmail tools.",
    );
    expect(
      buildingAgentLine({ agent: { id: "a", name: "Hermes" }, lastUsedAt: null }, "Gmail"),
    ).toBe(
      "Graft builds it as Hermes, the first agent that can use Gmail. Creating it lets Hermes build Gmail tools.",
    );
  });
});

describe("tryInAgents and tryInHint", () => {
  const built = { id: "b", name: "B" };

  it("puts the build's agent first and keeps it when the reads no longer list it", () => {
    const choices = [{ agent: { id: "a", name: "A" } }, { agent: { id: "b", name: "B" } }];
    expect(tryInAgents(choices, built).map((agent) => agent.id)).toEqual(["b", "a"]);
    expect(tryInAgents([], built)).toEqual([built]);
  });

  it("says the build's agent has it and another finds it", () => {
    expect(tryInHint(built, built, "Gmail")).toBe(
      "The tool is in B's working set. Paste this into its chat.",
    );
    expect(tryInHint({ id: "a", name: "A" }, built, "Gmail")).toBe(
      "A finds the tool through Graft, since Gmail is in its connections. Paste this into its chat.",
    );
  });
});

describe("buildingAgentId", () => {
  it("picks the agent that last used the integration", () => {
    const choices = newToolAgentChoices(
      ["c1"],
      [
        access("c1", [
          row("a", true, "2026-10-01T00:00:00.000Z"),
          row("b", true, "2026-10-09T00:00:00.000Z"),
          row("c", true),
        ]),
      ],
    );
    expect(buildingAgentId(choices)).toBe("b");
  });

  it("falls back to the first offered when nobody used it, and to null with nobody", () => {
    const choices = newToolAgentChoices(["c1"], [access("c1", [row("a", true), row("b", true)])]);
    expect(buildingAgentId(choices)).toBe("a");
    expect(buildingAgentId([])).toBeNull();
  });
});

describe("newToolConnectionId", () => {
  const choice = { agent: { id: "a", name: "A" }, connectionIds: ["c1", "c2"], lastUsedAt: null };

  it("keeps the person's choice when the agent reaches it, else the agent's oldest", () => {
    expect(newToolConnectionId(choice, "c2")).toBe("c2");
    expect(newToolConnectionId(choice, "c9")).toBe("c1");
    expect(newToolConnectionId(choice, null)).toBe("c1");
    expect(newToolConnectionId(undefined, "c1")).toBeNull();
  });
});

describe("runningNewToolJob", () => {
  it("follows the newest job still being built and never a finished one", () => {
    const older = job({ jobId: "old", createdAt: "2026-10-14T09:00:00.000Z" });
    const newer = job({ jobId: "new", status: "queued", createdAt: "2026-10-14T11:00:00.000Z" });
    const done = job({ jobId: "done", status: "succeeded", createdAt: "2026-10-14T12:00:00.000Z" });
    expect(runningNewToolJob([older, done, newer])?.jobId).toBe("new");
    expect(runningNewToolJob([done, job({ status: "failed" })])).toBeNull();
    expect(isNewToolJobWorking(newer)).toBe(true);
  });
});

describe("newToolStep and newToolOf", () => {
  const tool = {
    tool: "gmail__find_emails",
    vendor: "gmail",
    name: "find_emails",
    toolId: "t1",
    version: 1,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
    next: "",
  };

  it("maps a job to the dialog's view", () => {
    expect(newToolStep(null)).toBe("describe");
    expect(newToolStep(job({ status: "queued" }))).toBe("building");
    expect(newToolStep(job({ status: "succeeded" }))).toBe("ready");
    expect(newToolStep(job({ status: "failed" }))).toBe("failed");
  });

  it("answers the tool only for a passed job, so a failure never names one", () => {
    expect(newToolOf(job({ status: "succeeded", result: tool }))?.tool).toBe("gmail__find_emails");
    expect(
      newToolOf(
        job({
          status: "failed",
          result: { failure: "attempt_budget", message: "x", lastDiagnostics: null, tried: [] },
        }),
      ),
    ).toBeNull();
    expect(newToolOf(null)).toBeNull();
  });
});

describe("newToolPrompt", () => {
  it("writes the goal as one sentence naming Graft and the tool", () => {
    expect(newToolPrompt("Find emails from a sender this week", "gmail__find_emails")).toBe(
      "Using Graft's gmail__find_emails tool, find emails from a sender this week.",
    );
  });

  it("keeps a first word that is a name or I", () => {
    expect(newToolPrompt("GitHub issues assigned to me", "github__issues")).toBe(
      "Using Graft's github__issues tool, GitHub issues assigned to me.",
    );
    expect(newToolPrompt("I want my unread mail", "gmail__unread")).toBe(
      "Using Graft's gmail__unread tool, I want my unread mail.",
    );
  });

  it("asks for the tool itself when there is no goal", () => {
    expect(newToolPrompt("  ", "gmail__x")).toBe("Using Graft, run the gmail__x tool.");
  });
});

describe("newToolReadyLine", () => {
  it("says a read runs without asking and a write asks first", () => {
    expect(newToolReadyLine("Hermes", { readOnlyHint: true })).toBe(
      "Hermes can use it now. It only reads, so it runs without asking.",
    );
    expect(newToolReadyLine("Hermes", { readOnlyHint: false })).toContain(
      "you approve its first run",
    );
  });
});

describe("newToolAttemptsLine", () => {
  it("counts the attempts", () => {
    expect(newToolAttemptsLine(0)).toBe("");
    expect(newToolAttemptsLine(1)).toBe("It tried once.");
    expect(newToolAttemptsLine(3)).toBe("It tried 3 times.");
  });
});

describe("the progress row", () => {
  const checking = ["Queued: x", "Attempt 1: checking the module"];

  it("names the stage and the part while working", () => {
    const working = job({ progress: checking });
    expect(newToolProgressNote(working)).toBe("Checking it · 3 of 5");
    expect(newToolProgressFraction(working)).toBe(3 / 5);
    expect(newToolPartRows(working).map((entry) => entry.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
      "pending",
    ]);
  });

  it("says where a failure stopped, and marks that part failed", () => {
    const failed = job({
      status: "failed",
      progress: checking,
      result: { failure: "attempt_budget", message: "No.", lastDiagnostics: null, tried: [] },
    });
    expect(newToolProgressNote(failed)).toBe("Stopped at checking it · 3 of 5");
    expect(newToolProgressFraction(failed)).toBe(3 / 5);
    expect(newToolPartRows(failed)[2]?.state).toBe("failed");
  });

  it("is whole on a pass, and the card's label before any stage", () => {
    expect(newToolProgressFraction(job({ status: "succeeded" }))).toBe(1);
    expect(newToolPartRows(job({ status: "succeeded" })).every((r) => r.state === "done")).toBe(
      true,
    );
    expect(newToolProgressNote(job({ status: "queued", progress: ["Queued: x"] }))).toBe(
      "Waiting to start",
    );
  });
});

describe("toolAccessChip", () => {
  it("reads, changes data or can delete, from the annotations", () => {
    expect(toolAccessChip({ readOnlyHint: true, destructiveHint: false })).toBe(
      TOOL_ACCESS_CHIP.read,
    );
    expect(toolAccessChip({ readOnlyHint: false, destructiveHint: false })).toBe(
      TOOL_ACCESS_CHIP.changes,
    );
    expect(toolAccessChip({ readOnlyHint: false, destructiveHint: true })).toBe(
      TOOL_ACCESS_CHIP.deletes,
    );
  });
});
