import { describe, expect, it } from "vitest";

import type { AgentAccess } from "./agent-access";
import type { ConnectionAccessView } from "./connection-queries";
import {
  integrationAgentRows,
  integrationAnswers,
  type ToolApproval,
  toolAnswerChoice,
  toolAnswerWrites,
} from "./integration-agents";
import { ANSWER_CHIP } from "./status-chips";

const OLD = "2026-10-01T10:00:00.000Z";
const MID = "2026-10-05T10:00:00.000Z";
const NEW = "2026-10-10T10:00:00.000Z";

const GMAIL = { id: "conn_1", displayName: "Gmail" };
const WORK = { id: "conn_2", displayName: "Work Gmail" };

function approval(
  name: string,
  over: Partial<Omit<ToolApproval, "tool">> & { readOnly?: boolean; destructive?: boolean } = {},
): ToolApproval {
  const { readOnly = false, destructive = false, ...rest } = over;
  return {
    tool: {
      id: `tool_${name}`,
      vendor: "gmail",
      name,
      description: name,
      readOnly,
      destructive,
      currentVersionId: "ver_2",
    },
    decision: "allow",
    askEveryCall: false,
    toolVersionId: "ver_2",
    forCurrentVersion: true,
    decidedAt: MID,
    ...rest,
  };
}

function agent(id: string, over: Partial<AgentAccess> = {}): AgentAccess {
  return {
    agent: { id, name: id, scopeMode: "all", connectedViaClientName: null },
    inScope: true,
    lastUsedAt: null,
    toolApprovals: [],
    vendorApproval: null,
    buildApproval: null,
    ...over,
  };
}

const access = (connectionId: string, agents: AgentAccess[]): ConnectionAccessView => ({
  connectionId,
  vendor: "gmail",
  agents,
});

describe("integrationAgentRows", () => {
  it("folds each connection's read into one row per agent, with a switch per connection", () => {
    const rows = integrationAgentRows(
      [GMAIL, WORK],
      [
        access("conn_1", [agent("claude", { inScope: false }), agent("codex")]),
        access("conn_2", [
          agent("claude", { buildApproval: { grantedAt: OLD } }),
          agent("codex", { inScope: false }),
        ]),
      ],
    );
    expect(rows.map((row) => row.agent.id)).toEqual(["claude", "codex"]);
    const [claude, codex] = rows;
    expect(claude?.switches).toEqual([
      { connectionId: "conn_1", displayName: "Gmail", inScope: false },
      { connectionId: "conn_2", displayName: "Work Gmail", inScope: true },
    ]);
    // In scope through the second connection, so the summary does not say "No access".
    expect(claude?.access.inScope).toBe(true);
    expect(claude?.access.buildApproval).toEqual({ grantedAt: OLD });
    expect(claude?.buildApprovals).toEqual([
      { connectionId: "conn_2", displayName: "Work Gmail", grantedAt: OLD },
    ]);
    expect(codex?.access.inScope).toBe(true);
    expect(codex?.buildApprovals).toEqual([]);
  });

  it("never says an agent can build through a connection outside its scope", () => {
    const [row] = integrationAgentRows(
      [GMAIL, WORK],
      [
        access("conn_1", [agent("claude")]),
        access("conn_2", [agent("claude", { inScope: false, buildApproval: { grantedAt: OLD } })]),
      ],
    );
    expect(row?.access.buildApproval).toBeNull();
    // Still the person's answer, so still listed and withdrawable.
    expect(row?.buildApprovals.map((build) => build.connectionId)).toEqual(["conn_2"]);
  });

  it("is out of scope only when no connection reaches the agent", () => {
    const [row] = integrationAgentRows(
      [GMAIL],
      [access("conn_1", [agent("hermes", { inScope: false })])],
    );
    expect(row?.access.inScope).toBe(false);
  });

  it("leaves out a connection whose read has not answered", () => {
    const [row] = integrationAgentRows([GMAIL, WORK], [access("conn_2", [agent("codex")])]);
    expect(row?.switches.map((entry) => entry.connectionId)).toEqual(["conn_2"]);
  });
});

describe("toolAnswerChoice", () => {
  it("reads a deny before ask-every-call, as the gate does", () => {
    expect(toolAnswerChoice(approval("send", { decision: "deny", askEveryCall: true }))).toBe(
      "deny",
    );
    expect(toolAnswerChoice(approval("send", { askEveryCall: true }))).toBe("ask");
    expect(toolAnswerChoice(approval("send"))).toBe("always");
    expect(toolAnswerChoice(approval("send", { forCurrentVersion: false }))).toBe("stale");
  });
});

describe("toolAnswerWrites", () => {
  it("writes nothing for the answer already standing", () => {
    expect(toolAnswerWrites(approval("send"), "always")).toEqual([]);
    expect(toolAnswerWrites(approval("send", { askEveryCall: true }), "ask")).toEqual([]);
    expect(toolAnswerWrites(approval("send", { decision: "deny" }), "deny")).toEqual([]);
  });

  it("denies in one write", () => {
    expect(toolAnswerWrites(approval("send", { askEveryCall: true }), "deny")).toEqual([
      { kind: "decision", decision: "deny" },
    ]);
  });

  // The allow answers the tool's open asks only once it no longer asks every call (GRA-302), so
  // Always allow turns asking off first and then allows, a current allow included.
  it("turns ask-every-call off before allowing for Always allow, so the open asks close", () => {
    expect(toolAnswerWrites(approval("send", { askEveryCall: true }), "always")).toEqual([
      { kind: "ask_every_call", on: false },
      { kind: "decision", decision: "allow" },
    ]);
    expect(
      toolAnswerWrites(
        approval("send", { askEveryCall: true, forCurrentVersion: false }),
        "always",
      ),
    ).toEqual([
      { kind: "ask_every_call", on: false },
      { kind: "decision", decision: "allow" },
    ]);
    expect(
      toolAnswerWrites(approval("send", { decision: "deny", askEveryCall: true }), "always"),
    ).toEqual([
      { kind: "ask_every_call", on: false },
      { kind: "decision", decision: "allow" },
    ]);
    expect(toolAnswerWrites(approval("send", { decision: "deny" }), "always")).toEqual([
      { kind: "decision", decision: "allow" },
    ]);
    expect(toolAnswerWrites(approval("send", { forCurrentVersion: false }), "always")).toEqual([
      { kind: "decision", decision: "allow" },
    ]);
  });

  it("turns ask-every-call on before allowing, so no moment between the two runs unasked", () => {
    expect(toolAnswerWrites(approval("send", { decision: "deny" }), "ask")).toEqual([
      { kind: "ask_every_call", on: true },
      { kind: "decision", decision: "allow" },
    ]);
    expect(toolAnswerWrites(approval("send", { forCurrentVersion: false }), "ask")).toEqual([
      { kind: "ask_every_call", on: true },
      { kind: "decision", decision: "allow" },
    ]);
    expect(toolAnswerWrites(approval("send"), "ask")).toEqual([
      { kind: "ask_every_call", on: true },
    ]);
  });
});

describe("integrationAnswers", () => {
  const rows = integrationAgentRows(
    [GMAIL, WORK],
    [
      access("conn_1", [
        agent("claude", {
          toolApprovals: [
            approval("send-email", { askEveryCall: true, decidedAt: NEW }),
            approval("list-labels", { readOnly: true, decidedAt: OLD }),
          ],
          vendorApproval: { includesDestructive: false, grantedAt: MID },
          buildApproval: { grantedAt: OLD },
        }),
      ]),
      access("conn_2", [
        agent("claude", {
          toolApprovals: [
            approval("send-email", { askEveryCall: true, decidedAt: NEW }),
            approval("list-labels", { readOnly: true, decidedAt: OLD }),
          ],
          vendorApproval: { includesDestructive: false, grantedAt: MID },
        }),
      ]),
    ],
  );

  it("lists each answer once, newest first, the vendor's once however many connections", () => {
    const answers = integrationAnswers(rows, "Gmail", true);
    expect(answers.map((answer) => [answer.what, answer.detail, answer.chip])).toEqual([
      ["Send email", null, ANSWER_CHIP.ask_every_time],
      ["Every Gmail tool", "Except ones that delete", ANSWER_CHIP.always],
      ["List labels", "Reads never ask", ANSWER_CHIP.always],
      ["Build its own Gmail tools", "Gmail", ANSWER_CHIP.allowed],
    ]);
  });

  it("draws a read tool's answer as allowed whatever a write version of it left behind", () => {
    const [row] = integrationAgentRows(
      [GMAIL],
      [
        access("conn_1", [
          agent("codex", {
            toolApprovals: [approval("list-labels", { readOnly: true, decision: "deny" })],
          }),
        ]),
      ],
    );
    const [answer] = integrationAnswers(row ? [row] : [], "Gmail", false);
    expect(answer?.chip).toEqual(ANSWER_CHIP.always);
    expect(answer?.change).toEqual({ kind: "none" });
  });

  it("says when forgetting a tool's answer leaves it to the standing approval", () => {
    const forgets = (includesDestructive: boolean | null) => {
      const [row] = integrationAgentRows(
        [GMAIL],
        [
          access("conn_1", [
            agent("claude", {
              toolApprovals: [
                approval("send-email", { decision: "deny" }),
                approval("delete-email", { decision: "deny", destructive: true }),
              ],
              vendorApproval:
                includesDestructive === null ? null : { includesDestructive, grantedAt: OLD },
            }),
          ]),
        ],
      );
      return integrationAnswers(row ? [row] : [], "Gmail", false).flatMap((answer) =>
        answer.change.kind === "tool" ? [[answer.what, answer.change.forgetRunsUnasked]] : [],
      );
    };
    expect(forgets(null)).toEqual([
      ["Send email", false],
      ["Delete email", false],
    ]);
    expect(forgets(false)).toEqual([
      ["Send email", true],
      ["Delete email", false],
    ]);
    expect(forgets(true)).toEqual([
      ["Send email", true],
      ["Delete email", true],
    ]);
  });

  it("draws an allow for an earlier version as allowed when the standing approval covers it", () => {
    const chips = (includesDestructive: boolean | null) => {
      const [row] = integrationAgentRows(
        [GMAIL],
        [
          access("conn_1", [
            agent("claude", {
              toolApprovals: [
                approval("send-email", { forCurrentVersion: false }),
                approval("delete-email", { forCurrentVersion: false, destructive: true }),
              ],
              vendorApproval:
                includesDestructive === null ? null : { includesDestructive, grantedAt: OLD },
            }),
          ]),
        ],
      );
      return integrationAnswers(row ? [row] : [], "Gmail", false).flatMap((answer) =>
        answer.change.kind === "tool" ? [[answer.what, answer.chip, answer.detail]] : [],
      );
    };
    expect(chips(null)).toEqual([
      ["Send email", ANSWER_CHIP.asks_next_time, null],
      ["Delete email", ANSWER_CHIP.asks_next_time, null],
    ]);
    expect(chips(false)).toEqual([
      ["Send email", ANSWER_CHIP.always, "Allowed by Every Gmail tool"],
      ["Delete email", ANSWER_CHIP.asks_next_time, null],
    ]);
  });

  it("offers no change on a read tool's answer", () => {
    const answers = integrationAnswers(rows, "Gmail", false);
    const read = answers.find((answer) => answer.what === "List labels");
    expect(read?.change).toEqual({ kind: "none" });
    const build = answers.find((answer) => answer.change.kind === "build");
    expect(build?.detail).toBeNull();
    expect(build?.change).toEqual({ kind: "build", connectionId: "conn_1" });
  });
});
