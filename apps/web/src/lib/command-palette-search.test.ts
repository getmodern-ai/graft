import { describe, expect, it } from "vitest";

import type { ActivityRow } from "./activity-screen";
import type { AgentListItem } from "./agent-queries";
import {
  activitySentence,
  agentItems,
  integrationDetail,
  type PaletteSources,
  paletteView,
  toolKindLabel,
} from "./command-palette-search";
import type { ToolboxTool } from "./connection-queries";
import type { Integration, IntegrationConnection } from "./integration-queries";
import type { PendingAction } from "./pending-action-queries";
import type { DirectoryEntry } from "./setup-queries";

/** What the command palette finds (GRA-329). */

const NOW = new Date("2026-10-14T12:00:00.000Z");
const at = "2026-10-01T09:00:00.000Z";

const gmailConnection: IntegrationConnection = {
  id: "conn_gmail",
  provider: "keyring",
  vendor: "gmail",
  displayName: "Gmail",
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-api-key" },
  primaryHost: "https://gmail.googleapis.com",
  hosts: ["gmail.googleapis.com"],
  credentialSetAt: at,
  oauth: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  createdAt: at,
  updatedAt: at,
  state: "connected",
};

const gmail: Integration = {
  vendor: "gmail",
  displayName: "Gmail",
  connections: [gmailConnection],
  agents: [
    { id: "agt_1", name: "Claude", harness: "Claude" },
    { id: "agt_2", name: "Codex", harness: "Codex" },
    { id: "agt_3", name: "Hermes", harness: null },
  ],
  toolCount: 10,
  lastUsedAt: null,
  needsAttention: null,
};

const hubspot: Integration = {
  vendor: "hubspot",
  displayName: "HubSpot",
  connections: [
    {
      ...gmailConnection,
      id: "conn_hubspot",
      vendor: "hubspot",
      displayName: "HubSpot",
      hosts: ["api.hubapi.com"],
      scheme: "oauth_authorization_code",
      schemeConfig: {
        clientId: "client",
        authorizeUrl: "https://app.hubspot.com/oauth/authorize",
        tokenUrl: "https://api.hubapi.com/oauth/v1/token",
      },
      oauth: {
        status: "consent_required",
        consentedAt: at,
        expiresAt: null,
        refreshedAt: null,
        consentRequired: { at: "2026-10-14T11:00:00.000Z", reason: "refused" },
      },
      state: "consent_required",
    },
  ],
  agents: [{ id: "agt_1", name: "Claude", harness: "Claude" }],
  toolCount: 2,
  lastUsedAt: null,
  needsAttention: { connectionId: "conn_hubspot", reason: "consent_required" },
};

const tool = (name: string, over: Partial<ToolboxTool> = {}): ToolboxTool => ({
  id: `tool_${name}`,
  vendor: "gmail",
  name,
  description: "A Gmail tool.",
  readOnly: false,
  destructive: false,
  defaultConnectionId: "conn_gmail",
  currentVersionId: `ver_${name}`,
  createdAt: at,
  updatedAt: at,
  lineage: "authored",
  versions: [],
  ...over,
});

function ask(id: string, toolName: string, createdAt = "2026-10-14T11:58:00.000Z"): PendingAction {
  return {
    id,
    agentId: "agt_2",
    agent: { id: "agt_2", name: "Codex", clientName: "Codex" },
    kind: "tool",
    payload: {
      toolId: "tool_1",
      toolName,
      vendor: "gmail",
      description: "",
      annotations: { readOnlyHint: false, destructiveHint: false },
      connectionId: "conn_gmail",
      connectionName: "Gmail",
      integrationName: "Gmail",
      hosts: ["gmail.googleapis.com"],
      note: "",
      askEveryCall: false,
    },
    expiresAt: "2026-10-15T12:00:00.000Z",
    createdAt,
    answeredAt: null,
    answer: null,
    consumedAt: null,
    url: `https://console.example/pending/${id}?t=h`,
  };
}

const run = (over: Partial<Extract<ActivityRow, { kind: "run" }>> = {}): ActivityRow => ({
  kind: "run",
  key: "run:1",
  id: "use_1",
  at: "2026-10-14T11:58:00.000Z",
  agent: { id: "agt_2", name: "Codex" },
  vendor: "gmail",
  connectionId: "conn_gmail",
  tool: { id: "tool_find_invoices", wireName: "gmail__find_invoices", description: null },
  outcome: "ok",
  reason: null,
  asked: false,
  latencyMs: 300,
  dryRun: false,
  ...over,
});

const agent: AgentListItem = {
  id: "agt_1",
  name: "Claude",
  tokenPrefix: null,
  connectedVia: { clientId: "client_1", clientName: "Claude" },
  scopeMode: "all",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  createdAt: at,
  updatedAt: at,
  workingSetCount: 4,
  connectionIds: [],
  lastActiveAt: null,
};

const stripe: DirectoryEntry = {
  slug: "stripe",
  name: "Stripe",
  description: "payments, customers and invoices",
  logoUrl: null,
  categories: [],
  hosts: ["api.stripe.com"],
  docsUrl: null,
  connect: "link",
  scheme: "bearer",
  starterId: "stripe",
};

const sources: PaletteSources = {
  integrations: [gmail, hubspot],
  tools: [
    tool("send_email"),
    tool("find_invoices", { readOnly: true }),
    tool("delete_email", { destructive: true }),
    tool("never_published", { currentVersionId: null }),
  ],
  pendingActions: [ask("pa_1", "gmail__send_email"), ask("pa_2", "gmail__draft_reply")],
  agents: [agent, { ...agent, id: "agt_old", name: "Old Codex", revokedAt: at }],
  activity: [run()],
};

const shape = (view: ReturnType<typeof paletteView>) =>
  view.groups.map((group) => [group.name, group.items.map((item) => item.label)]);

describe("paletteView, just opened", () => {
  it("lists the open requests, sign-ins first, then Go to and Do something", () => {
    const view = paletteView(sources, "", NOW);
    expect(view.notice).toBeNull();
    expect(shape(view)).toEqual([
      [
        "Needs you",
        [
          "HubSpot signed you out",
          "Codex wants to send email in Gmail",
          "Codex wants to draft reply in Gmail",
        ],
      ],
      ["Go to", ["Home", "Requests", "Agents", "Integrations", "Activity", "Settings"]],
      ["Do something", ["Connect an integration", "Connect another agent", "Add a custom API"]],
    ]);
    const [signIn, request] = view.groups[0]?.items ?? [];
    expect(signIn?.open).toEqual({
      to: "/integrations/$vendor",
      params: { vendor: "hubspot" },
      search: { tab: "connection" },
    });
    expect(request?.open).toEqual({ request: "pa_1" });
    expect(request?.detail).toBe("Request · 2 minutes ago");
  });

  it("says how many more there are past the first three", () => {
    const view = paletteView(
      { ...sources, pendingActions: [ask("pa_1", "a"), ask("pa_2", "b"), ask("pa_3", "c")] },
      "",
      NOW,
    );
    const needsYou = view.groups[0]?.items ?? [];
    expect(needsYou.map((item) => item.label)).toHaveLength(4);
    expect(needsYou.at(-1)).toMatchObject({
      label: "See all 4 requests",
      open: { to: "/pending" },
    });
  });

  it("leaves Needs you out with nothing open, and draws before any read lands", () => {
    expect(shape(paletteView({}, "", NOW)).map(([name]) => name)).toEqual([
      "Go to",
      "Do something",
    ]);
  });
});

describe("paletteView, typing", () => {
  it("finds an integration, its tools, its requests and its activity, each opening its screen", () => {
    const view = paletteView(sources, "gmail", NOW);
    expect(view.notice).toBeNull();
    expect(shape(view)).toEqual([
      ["Integrations", ["Gmail"]],
      ["Tools", ["Send email", "Find invoices", "Delete email"]],
      ["Requests", ["Codex wants to send email in Gmail", "Codex wants to draft reply in Gmail"]],
      ["Activity", ["Codex ran Find invoices in Gmail"]],
    ]);
    const [integrations, tools, , activity] = view.groups;
    expect(integrations?.items[0]).toMatchObject({
      detail: "Connected · 10 tools · used by 3 agents",
      open: { to: "/integrations/$vendor", params: { vendor: "gmail" } },
    });
    expect(tools?.items.map((item) => item.detail)).toEqual([
      "Gmail · Changes data",
      "Gmail · Read",
      "Gmail · Can delete",
    ]);
    expect(activity?.items[0]?.open).toEqual({
      to: "/activity",
      search: { vendor: "gmail", agent: "agt_2" },
    });
  });

  it("never lists a tool with no version to run", () => {
    const labels = shape(paletteView(sources, "never", NOW)).flatMap(([, items]) => items);
    expect(labels).not.toContain("Never published");
  });

  it("finds agents, active before revoked, and the screens and verbs beside them", () => {
    // The revoked one connected through Claude too, and comes after.
    expect(shape(paletteView(sources, "claude", NOW))).toEqual([
      ["Agents", ["Claude", "Old Codex"]],
    ]);
    expect(shape(paletteView(sources, "codex", NOW))[0]).toEqual([
      "Requests",
      ["Codex wants to send email in Gmail", "Codex wants to draft reply in Gmail"],
    ]);
    expect(shape(paletteView(sources, "set", NOW))).toContainEqual(["Go to", ["Settings"]]);
  });

  it("puts the directory's unconnected integrations under what the person has", () => {
    const view = paletteView(
      {
        ...sources,
        directory: [{ ...stripe, slug: "gmail", name: "Gmail", starterId: "gmail" }, stripe],
      },
      "gmail",
      NOW,
    );
    expect(view.groups.at(-1)).toMatchObject({
      name: "Connect a new integration",
      items: [{ label: "Stripe" }],
    });
    expect(view.groups.map((group) => group.name)).not.toContain("Can't find it?");
  });
});

describe("paletteView, an integration not connected", () => {
  it("offers the directory's hit, Search all N and a custom API from its docs", () => {
    const view = paletteView(
      { ...sources, directory: [stripe], directoryTotal: 3224 },
      "stripe",
      NOW,
    );
    expect(view.notice).toBe("Nothing you've connected matches “stripe”.");
    expect(shape(view)).toEqual([
      ["Connect a new integration", ["Stripe"]],
      [
        "Can't find it?",
        ["Search all 3,224 integrations for “stripe”", "Connect any API from a link to its docs"],
      ],
    ]);
    const [hit] = view.groups[0]?.items ?? [];
    expect(hit).toMatchObject({
      detail: "Not connected · payments, customers and invoices",
      hint: "Connect",
      open: { to: "/integrations", search: { tab: "discover", q: "Stripe" } },
    });
    expect(view.groups[1]?.items.map((item) => item.open)).toEqual([
      { to: "/integrations", search: { tab: "discover", q: "stripe" } },
      { to: "/integrations", search: { tab: "discover", custom: "stripe" } },
    ]);
  });

  it("works with the open form's small directory and before its size is known", () => {
    const one = paletteView({ directory: [], directoryTotal: 1 }, "acme", NOW);
    expect(one.groups[0]?.items[0]?.label).toBe("Search the directory for “acme”");
    const ten = paletteView({ directory: [], directoryTotal: 10 }, "acme", NOW);
    expect(ten.groups[0]?.items[0]?.label).toBe("Search all 10 integrations for “acme”");
    const unknown = paletteView({}, "acme", NOW);
    expect(unknown.groups[0]?.items[0]?.label).toBe("Search the directory for “acme”");
  });

  it("keeps Can't find it? but drops the notice when a screen or a verb answers", () => {
    const view = paletteView(sources, "connect", NOW);
    expect(view.notice).toBeNull();
    expect(view.groups.map((group) => group.name)).toEqual([
      "Go to",
      "Do something",
      "Can't find it?",
    ]);
  });
});

describe("toolKindLabel", () => {
  it("says what the tool may do, never what an agent was allowed", () => {
    expect(toolKindLabel({ readOnly: true, destructive: false })).toBe("Read");
    expect(toolKindLabel({ readOnly: false, destructive: false })).toBe("Changes data");
    expect(toolKindLabel({ readOnly: false, destructive: true })).toBe("Can delete");
  });
});

describe("integrationDetail", () => {
  it("names who is cut off when it needs the person", () => {
    expect(integrationDetail(hubspot)).toBe("Signed out, so Claude can't use it");
    expect(integrationDetail({ ...gmail, agents: [], toolCount: 1 })).toBe("Connected · 1 tool");
  });
});

describe("activitySentence", () => {
  const names = { byVendor: new Map([["gmail", "Gmail"]]), byConnection: new Map() };

  it("words a run by how it ended", () => {
    expect(activitySentence(run(), names)).toBe("Codex ran Find invoices in Gmail");
    expect(activitySentence(run({ outcome: "refused" }), names)).toBe(
      "Codex was blocked from Find invoices in Gmail",
    );
    expect(activitySentence(run({ outcome: "error" }), names)).toBe(
      "Codex's Find invoices in Gmail failed",
    );
  });
});

describe("agentItems", () => {
  it("says the client an agent connected through, or that none was recorded", () => {
    const rows = agentItems([
      { ...agent, id: "agt_old", name: "Old", revokedAt: at },
      { ...agent, id: "agt_tok", name: "Hermes", connectedVia: null },
    ]);
    expect(rows.map((row) => [row.label, row.detail])).toEqual([
      ["Hermes", "Not recorded"],
      ["Old", "Revoked"],
    ]);
    expect(rows[0]?.open).toEqual({ to: "/agents/$agentId", params: { agentId: "agt_tok" } });
  });
});
