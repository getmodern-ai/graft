import { describe, expect, it } from "vitest";

import {
  buildApprovalSentence,
  changeDialogTitle,
  type DoneRequest,
  decisionToast,
  doneRowCopy,
  doneRowWhen,
  standingBuild,
  standingTool,
  standingVendor,
  toolChangeView,
} from "./request-done";

const NOW = new Date("2026-10-14T12:00:00.000Z");

function card(
  kind: string,
  payload: Record<string, unknown>,
  finish: Partial<DoneRequest> = {},
): DoneRequest {
  return {
    id: "pa_1",
    agentId: "agt_1",
    agent: { id: "agt_1", name: "Codex", clientName: null },
    kind,
    payload,
    expiresAt: "2026-10-14T10:00:00.000Z",
    createdAt: "2026-10-14T09:00:00.000Z",
    answeredAt: "2026-10-14T09:30:00.000Z",
    answer: { allow: true },
    consumedAt: "2026-10-14T09:30:00.000Z",
    state: "answered",
    closedReason: null,
    finishedAt: "2026-10-14T09:30:00.000Z",
    subject: { toolId: null, vendor: null, connectionId: null },
    ...finish,
  };
}

const tool = (overrides: Record<string, unknown> = {}) => ({
  toolId: "tool_1",
  toolName: "gmail__send_email",
  vendor: "gmail",
  description: "Sends an email.",
  annotations: { readOnlyHint: false, destructiveHint: false },
  connectionId: "con_1",
  connectionName: "Gmail",
  integrationName: "Gmail",
  hosts: ["gmail.googleapis.com"],
  note: "",
  askEveryCall: false,
  ...overrides,
});

const proposal = (overrides: Record<string, unknown> = {}) => ({
  provider: "keyring",
  providerConnect: "form",
  vendor: "notion",
  displayName: "Notion",
  scheme: "bearer",
  schemeConfig: {},
  primaryHost: "https://api.notion.com",
  hosts: ["api.notion.com"],
  docsUrl: null,
  note: "",
  ...overrides,
});

const build = { connectionId: "con_1", vendor: "gmail", connectionName: "Gmail", hosts: [] };

describe("doneRowCopy: tool asks", () => {
  it("says an allow holds, and offers the tool's and the integration's answers", () => {
    const copy = doneRowCopy(
      card("tool", tool(), { answer: { allow: true, askEveryCall: false } }),
      true,
    );
    expect(copy.title).toBe("Codex can always send email in Gmail");
    expect(copy.detail).toBeNull();
    expect(copy.change).toEqual({
      tool: { toolId: "tool_1", label: "Send email" },
      vendor: { slug: "gmail", integrationName: "Gmail" },
      buildConnectionId: null,
    });
  });

  it("words an allow that left ask-every-call as it stood without claiming it never asks", () => {
    // A Hermes button's answer carries no `askEveryCall`; the server kept the tool's setting.
    const copy = doneRowCopy(card("tool", tool(), { answer: { allow: true } }), true);
    expect(copy.title).toBe("Codex can send email in Gmail");
    expect(copy.detail).toBe("You allowed it");
    expect(copy.change).not.toBeNull();
  });

  it("says a deny", () => {
    const copy = doneRowCopy(
      card("tool", tool({ toolName: "hubspot__delete_contacts" }), { answer: { allow: false } }),
      true,
    );
    expect(copy.title).toBe("Codex can't delete contacts in Gmail");
    expect(copy.detail).toBe("You denied it");
    expect(copy.change).not.toBeNull();
  });

  it("says an allow for every tool of the integration, with or without destructive ones", () => {
    const every = doneRowCopy(
      card("tool", tool(), { answer: { allow: true, allowVendor: true } }),
      true,
    );
    expect(every.title).toBe("Codex can use every Gmail tool");
    expect(every.detail).toBe("Except ones that delete");
    const all = doneRowCopy(
      card("tool", tool(), {
        answer: { allow: true, allowVendor: true, includesDestructive: true },
      }),
      true,
    );
    expect(all.detail).toBe("Including ones that delete");
  });

  it("says a yes that asks every time, and never 'Allowed once'", () => {
    const copy = doneRowCopy(
      card("tool", tool(), { answer: { allow: true, askEveryCall: true } }),
      true,
    );
    expect(copy.title).toBe("Codex can send email in Gmail when you say yes");
    expect(copy.detail).toBe("Asks you every time");
    expect(JSON.stringify(copy)).not.toMatch(/once/i);
  });

  it("offers no Change for a read tool or a revoked agent", () => {
    const read = tool({ annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(doneRowCopy(card("tool", read), true).change).toBeNull();
    expect(doneRowCopy(card("tool", tool()), false).change).toBeNull();
  });
});

describe("doneRowCopy: build, scope and connection asks", () => {
  it("says a build approval and offers its withdrawal", () => {
    const copy = doneRowCopy(card("build", build), true);
    expect(copy.title).toBe("Codex can build its own Gmail tools");
    expect(copy.change).toEqual({
      tool: null,
      vendor: { slug: "gmail", integrationName: "Gmail" },
      buildConnectionId: "con_1",
    });
  });

  it("says a declined build with nothing to change", () => {
    const copy = doneRowCopy(card("build", build, { answer: { allow: false } }), true);
    expect(copy.title).toBe("Codex can't build its own Gmail tools");
    expect(copy.detail).toBe("You declined it");
    expect(copy.change).toBeNull();
  });

  it("says a scope allowed, and opens the build and integration approvals it may have granted", () => {
    const scope = {
      connectionId: "con_2",
      vendor: "google_drive",
      displayName: "Google Drive",
      hosts: ["www.googleapis.com"],
    };
    const targets = {
      tool: null,
      vendor: { slug: "google_drive", integrationName: "Google Drive" },
      buildConnectionId: "con_2",
    };
    expect(doneRowCopy(card("scope", scope), true)).toMatchObject({
      title: "Codex can use Google Drive",
      detail: null,
      change: targets,
    });
    // Full access: the build approval and every non-destructive tool, both reachable from Change.
    expect(
      doneRowCopy(
        card("scope", scope, { answer: { allow: true, approveBuild: true, allowVendor: true } }),
        true,
      ),
    ).toMatchObject({ detail: "And build its own tools for it", change: targets });
    expect(doneRowCopy(card("scope", scope), false).change).toBeNull();
  });

  it("says a connection made, and opens what its confirmation may have granted", () => {
    // The answer as the server records it: `{ connectionId }` alone, the grants rows of their own.
    const made = doneRowCopy(
      card("connection", proposal(), {
        answer: { connectionId: "con_9" },
        subject: { toolId: null, vendor: "notion", connectionId: "con_9" },
      }),
      true,
    );
    expect(made).toMatchObject({ title: "Connected Notion", detail: "For Codex" });
    expect(made.change).toEqual({
      tool: null,
      vendor: { slug: "notion", integrationName: "Notion" },
      buildConnectionId: "con_9",
    });
  });

  it("offers no Change for a credential re-entry, or a revoked agent's connection", () => {
    const credential = {
      connectionId: "con_1",
      vendor: "gmail",
      connectionName: "Gmail",
      scheme: "bearer",
      schemeConfig: {},
      revoked: true,
    };
    const reconnected = doneRowCopy(
      card("credential", credential, {
        answer: { connectionId: "con_1" },
        subject: { toolId: null, vendor: "gmail", connectionId: "con_1" },
      }),
      true,
    );
    expect(reconnected).toMatchObject({ title: "Reconnected Gmail", change: null });
    expect(
      doneRowCopy(
        card("connection", proposal(), {
          answer: { connectionId: "con_9" },
          subject: { toolId: null, vendor: "notion", connectionId: "con_9" },
        }),
        false,
      ).change,
    ).toBeNull();
  });

  it("says a declined connection", () => {
    expect(
      doneRowCopy(card("connection", proposal(), { answer: { allow: false } }), true).title,
    ).toBe("You declined Codex's request to connect Notion");
  });
});

describe("doneRowCopy: unanswered asks", () => {
  it("says an expiry, and that the agent asks again", () => {
    const copy = doneRowCopy(
      card("connection", proposal(), {
        agent: { id: "agt_1", name: "Hermes", clientName: null },
        answeredAt: null,
        answer: null,
        state: "expired",
      }),
      true,
    );
    expect(copy.title).toBe("Hermes's request to connect Notion expired");
    expect(copy.detail).toBe("Hermes will ask again if it still needs it");
    expect(copy.change).toBeNull();
  });

  it("says which revoke closed an ask", () => {
    const closed = (closedReason: "agent_revoked" | "connection_revoked") =>
      doneRowCopy(
        card("tool", tool({ vendor: "notion", integrationName: "Notion" }), {
          answeredAt: null,
          answer: null,
          state: "closed",
          closedReason,
        }),
        true,
      );
    expect(closed("agent_revoked").detail).toBe("Closed when you revoked Codex");
    expect(closed("connection_revoked").detail).toBe("Closed when you revoked Notion");
    expect(closed("agent_revoked").title).toBe("Codex's request to send email in Notion");
    expect(closed("agent_revoked").change).toBeNull();
  });
});

describe("doneRowWhen", () => {
  it("is when the ask finished, opening the line in sentence case", () => {
    expect(doneRowWhen({ finishedAt: "2026-10-14T09:00:00.000Z" }, false, NOW)).toEqual({
      iso: "2026-10-14T09:00:00.000Z",
      label: "3 hours ago",
    });
    expect(doneRowWhen({ finishedAt: "2026-10-13T09:00:00.000Z" }, true, NOW)?.label).toBe(
      "Yesterday",
    );
    expect(doneRowWhen({ finishedAt: "nope" }, true, NOW)).toBeNull();
  });
});

describe("what stands now", () => {
  it("reads the tool's, the integration's and the build approval off their reads", () => {
    const row = { toolId: "tool_1", decision: "allow" as const, askEveryCall: false };
    expect(standingTool([{ ...row, toolVersionId: "v2" }], "tool_1", "v2")).toEqual({
      decision: "allow",
      askEveryCall: false,
      forThisVersion: true,
    });
    expect(standingTool([{ ...row, toolVersionId: "v1" }], "tool_1", "v2")?.forThisVersion).toBe(
      false,
    );
    expect(standingTool([{ ...row, toolVersionId: null }], "tool_1", null)?.forThisVersion).toBe(
      false,
    );
    expect(standingTool([], "tool_1", "v2")).toBeNull();
    expect(standingVendor([{ vendor: "gmail", includesDestructive: true }], "gmail")).toEqual({
      includesDestructive: true,
    });
    expect(standingVendor([], "gmail")).toBeNull();
    expect(standingBuild([{ connectionId: "con_1" }], "con_1")).toBe(true);
    expect(standingBuild([], "con_1")).toBe(false);
  });

  describe("toolChangeView", () => {
    const write = { currentVersionId: "v2", readOnly: false, destructive: false };
    const allow = (forThisVersion: boolean, askEveryCall = false) => ({
      decision: "allow" as const,
      askEveryCall,
      forThisVersion,
    });

    it("says an allow for this version holds, and offers Deny and Withdraw, not Allow", () => {
      expect(toolChangeView(write, allow(true), null)).toEqual({
        sentence: "Allowed. It runs without asking.",
        allow: false,
        deny: true,
        withdraw: true,
        askEveryCall: false,
        destructive: false,
      });
    });

    it("says an allow for an earlier version asks again, and offers Allow for this one", () => {
      const view = toolChangeView(write, allow(false), null);
      expect(view.sentence).toBe(
        "Allowed for an earlier version. It asks once before running this one.",
      );
      expect(view.allow).toBe(true);
    });

    it("lets the tool's deny and ask-every-call win over the integration's yes", () => {
      const vendor = { includesDestructive: true };
      const deny = { decision: "deny" as const, askEveryCall: false, forThisVersion: false };
      expect(toolChangeView(write, deny, vendor)).toMatchObject({
        sentence: "Denied. Every call is refused.",
        allow: true,
        deny: false,
        askEveryCall: null,
      });
      expect(toolChangeView(write, allow(true, true), vendor).sentence).toBe(
        "Asks you before every call.",
      );
    });

    it("judges the integration's approval on the current version's annotations", () => {
      const vendor = { includesDestructive: false };
      expect(toolChangeView(write, null, vendor).sentence).toMatch(/integration's approval/);
      const nowDestructive = { ...write, destructive: true };
      expect(toolChangeView(nowDestructive, null, vendor)).toMatchObject({
        sentence: "No answer stands. It asks the next time it runs.",
        destructive: true,
        withdraw: false,
      });
    });

    it("offers nothing to set for a tool gone, read-only now, or with no version", () => {
      expect(toolChangeView(null, allow(true), null)).toMatchObject({
        allow: false,
        deny: false,
        withdraw: true,
      });
      expect(toolChangeView({ ...write, readOnly: true }, null, null)).toMatchObject({
        sentence: "It only reads now, so it never asks.",
        allow: false,
        deny: false,
        withdraw: false,
      });
      expect(
        toolChangeView({ ...write, currentVersionId: null }, allow(false), null),
      ).toMatchObject({ allow: false, deny: false, withdraw: true });
    });
  });

  it("says whether what the agent builds asks, by the integration's approval beside it", () => {
    expect(buildApprovalSentence("Gmail", null)).toBe(
      "Anything it builds still asks before changing data",
    );
    expect(buildApprovalSentence("Gmail", { includesDestructive: false })).toBe(
      "Tools it builds that change data run without asking, because every Gmail tool is allowed. Ones that delete still ask",
    );
    expect(buildApprovalSentence("Gmail", { includesDestructive: true })).toBe(
      "Tools it builds run without asking, because every Gmail tool is allowed",
    );
    expect(buildApprovalSentence(null, { includesDestructive: true })).toBe(
      "Anything it builds still asks before changing data",
    );
  });

  it("words Change's toast by the ask-every-call setting the route returned", () => {
    expect(decisionToast("allow", false, "Codex")).toEqual({
      title: "Allowed",
      description: "Codex runs it without asking.",
    });
    expect(decisionToast("allow", true, "Codex")).toEqual({
      title: "Allowed",
      description: "It still asks you before every call, as you set it to.",
    });
    expect(decisionToast("deny", true, "Codex")).toEqual({
      title: "Denied",
      description: "Codex's calls to it are refused.",
    });
  });

  it("titles the dialog by what stands, not the row's past", () => {
    expect(changeDialogTitle("Codex", "Gmail")).toBe("What Codex can do in Gmail");
    expect(changeDialogTitle("Codex", null)).toBe("What Codex can do");
  });
});
