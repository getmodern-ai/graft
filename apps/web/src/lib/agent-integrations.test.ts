import { describe, expect, it } from "vitest";

import {
  agentIntegrationRows,
  integrationAccessClause,
  integrationAccessLine,
  laterSwitchCopy,
} from "./agent-integrations";
import type { Connection } from "./connection-queries";
import type { ScopeState } from "./scope-toggles";

const AT = "2026-10-14T10:00:00.000Z";

function tool(name: string, over: { readOnly?: boolean; destructive?: boolean } = {}) {
  return {
    id: `tool_${name}`,
    vendor: "gmail",
    name,
    readOnly: over.readOnly ?? false,
    destructive: over.destructive ?? false,
    currentVersionId: `ver_${name}`,
  };
}

function allow(name: string, over: { askEveryCall?: boolean; toolVersionId?: string } = {}) {
  return {
    toolId: `tool_${name}`,
    decision: "allow" as const,
    askEveryCall: over.askEveryCall ?? false,
    toolVersionId: over.toolVersionId ?? `ver_${name}`,
  };
}

function connection(over: Partial<Connection> = {}): Connection {
  return {
    id: "conn_gmail",
    provider: "keyring",
    vendor: "gmail",
    displayName: "Gmail",
    scheme: "bearer",
    schemeConfig: {},
    primaryHost: "gmail.googleapis.com",
    hosts: ["gmail.googleapis.com"],
    credentialSetAt: AT,
    oauth: null,
    providerReleaseFailedAt: null,
    account: null,
    revokedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

const read = tool("list-messages", { readOnly: true });
const send = tool("send");
const draft = tool("draft-reply");
const remove = tool("delete-message", { destructive: true });

describe("integrationAccessClause", () => {
  it("says reads run and changes ask when nothing is answered", () => {
    expect(integrationAccessClause([read, send], [], null)).toBe(
      "reads run without asking, changes ask first",
    );
  });

  it("names a tool set to ask every time, as the design's line does", () => {
    expect(
      integrationAccessClause([read, send], [allow("send", { askEveryCall: true })], null),
    ).toBe("reads run without asking, Send asks every time");
  });

  it("names the changes allowed on their own, and what still asks", () => {
    expect(integrationAccessClause([read, send, draft], [allow("draft-reply")], null)).toBe(
      "reads and Draft reply run without asking, other changes ask first",
    );
  });

  it("does not count an allow given for another version, which asks again once", () => {
    expect(
      integrationAccessClause([send], [allow("send", { toolVersionId: "ver_old" })], null),
    ).toBe("reads run without asking, changes ask first");
  });

  it("says every tool runs when every change passes", () => {
    expect(integrationAccessClause([read, send], [allow("send")], null)).toBe(
      "every tool runs without asking",
    );
    expect(
      integrationAccessClause([read, send, remove], [], {
        vendor: "gmail",
        includesDestructive: true,
      }),
    ).toBe("every tool runs without asking");
  });

  it("under the standing approval names what it leaves out, ones that delete included", () => {
    expect(
      integrationAccessClause([read, send, remove], [], {
        vendor: "gmail",
        includesDestructive: false,
      }),
    ).toBe("Delete message asks first, the rest run without asking");
  });

  it("lets a tool's own deny and ask-every-call win over the standing approval", () => {
    expect(
      integrationAccessClause(
        [send, draft, remove],
        [
          allow("send", { askEveryCall: true }),
          {
            toolId: "tool_draft-reply",
            decision: "deny",
            askEveryCall: false,
            toolVersionId: null,
          },
        ],
        { vendor: "gmail", includesDestructive: true },
      ),
    ).toBe("Send asks every time, Draft reply is refused, the rest run without asking");
  });

  it("agrees the verb with a list of several", () => {
    expect(
      integrationAccessClause(
        [send, draft],
        [allow("send", { askEveryCall: true }), allow("draft-reply", { askEveryCall: true })],
        null,
      ),
    ).toBe("reads run without asking, Send and Draft reply ask every time");
  });
});

describe("integrationAccessLine", () => {
  const base = {
    agentName: "Claude",
    on: true,
    blocked: false,
    access: { toolCount: 6, clause: "x" },
  };

  it("leads with the tool count", () => {
    expect(integrationAccessLine(base)).toBe("6 tools · x");
    expect(integrationAccessLine({ ...base, access: { toolCount: 1, clause: "x" } })).toBe(
      "1 tool · x",
    );
  });

  it("says what the scope and the connections say while the access is not read", () => {
    const unread = { ...base, access: null };
    expect(integrationAccessLine(unread)).toBe("Available to Claude");
    expect(integrationAccessLine({ ...unread, on: false })).toBe("Not available to Claude");
    expect(integrationAccessLine({ ...unread, blocked: true })).toBe(
      "Can't run until you reconnect",
    );
  });

  it("says an integration that is off is not available to the agent", () => {
    expect(integrationAccessLine({ ...base, on: false, blocked: true })).toBe(
      "6 tools · not available to Claude",
    );
  });

  it("says a blocked integration can't run until the person reconnects, never paused", () => {
    expect(integrationAccessLine({ ...base, blocked: true })).toBe(
      "6 tools · can't run until you reconnect",
    );
  });

  it("says an integration with no tools has none yet", () => {
    expect(integrationAccessLine({ ...base, access: { toolCount: 0, clause: "x" } })).toBe(
      "No tools yet · Claude can build them",
    );
  });
});

describe("agentIntegrationRows", () => {
  const all: ScopeState = { mode: "all", connectionIds: new Set() };

  it("draws one row per integration, every switch on under all, by name", () => {
    const rows = agentIntegrationRows({
      agentName: "Claude",
      connections: [
        connection(),
        connection({ id: "conn_drive", vendor: "google_drive", displayName: "Drive" }),
      ],
      scope: all,
      access: { tools: [read, send], approvals: [], vendorApprovals: [] },
    });
    expect(rows.map((row) => [row.displayName, row.toolCount, row.line])).toEqual([
      ["Drive", 0, "No tools yet · Claude can build them"],
      ["Gmail", 2, "2 tools · reads run without asking, changes ask first"],
    ]);
    expect(rows.flatMap((row) => row.connections.map((entry) => entry.on))).toEqual([true, true]);
  });

  it("groups an integration's connections under one row, named for the oldest", () => {
    const [row] = agentIntegrationRows({
      agentName: "Claude",
      connections: [
        connection({
          id: "conn_b",
          displayName: "Gmail (work)",
          createdAt: "2026-10-02T00:00:00Z",
        }),
        connection({ id: "conn_a", displayName: "Gmail", createdAt: "2026-10-01T00:00:00Z" }),
      ],
      scope: { mode: "listed", connectionIds: new Set(["conn_b"]) },
      access: { tools: [], approvals: [], vendorApprovals: [] },
    });
    expect(row?.displayName).toBe("Gmail");
    expect(row?.connections.map((entry) => [entry.connection.id, entry.on])).toEqual([
      ["conn_a", false],
      ["conn_b", true],
    ]);
  });

  it("flags a connection that needs the person, and blocks the line only when none reached runs", () => {
    const signedOut = connection({
      scheme: "oauth_authorization_code",
      oauth: {
        status: "consent_required",
        consentedAt: AT,
        expiresAt: null,
        refreshedAt: null,
        consentRequired: { at: AT, reason: "invalid_grant" },
      },
    });
    const [row] = agentIntegrationRows({
      agentName: "Claude",
      connections: [signedOut],
      scope: all,
      access: { tools: [send], approvals: [], vendorApprovals: [] },
    });
    expect(row?.needsReconnect).toBe(true);
    expect(row?.line).toBe("1 tool · can't run until you reconnect");
  });

  it("shows a revoked connection only where the agent's list still names it", () => {
    const revoked = connection({ revokedAt: AT });
    const args = { agentName: "Claude", access: null };
    expect(agentIntegrationRows({ ...args, connections: [revoked], scope: all })).toEqual([]);
    expect(
      agentIntegrationRows({
        ...args,
        connections: [revoked],
        scope: { mode: "listed", connectionIds: new Set() },
      }),
    ).toEqual([]);
    const [row] = agentIntegrationRows({
      ...args,
      connections: [revoked],
      scope: { mode: "listed", connectionIds: new Set([revoked.id]) },
    });
    expect(row?.connections[0]?.status).toBe("revoked");
    expect(row?.toolCount).toBeNull();
    expect(row?.line).toBe("Can't run until you reconnect");
    expect(row?.needsReconnect).toBe(true);
  });
});

describe("laterSwitchCopy", () => {
  it("names the agent and recommends neither position (GRA-287 item 4)", () => {
    const copy = laterSwitchCopy("Claude");
    expect(copy.title).toBe("Give Claude integrations I connect later");
    expect(`${copy.title} ${copy.description}`.toLowerCase()).not.toContain("recommend");
  });
});
