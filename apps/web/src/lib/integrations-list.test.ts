import { describe, expect, it } from "vitest";

import type {
  Integration,
  IntegrationConnection,
  SuggestedIntegration,
} from "./integration-queries";
import {
  agentsPhrase,
  attentionSentence,
  integrationMatches,
  integrationSubline,
  integrationsListOf,
  readIntegrationsListSearch,
  readIntegrationsSort,
  signInOf,
  suggestedBanner,
  suggestedVendorsOf,
  toolsCell,
  usedByLabel,
} from "./integrations-list";

/**
 * The Connected tab (GRA-321): which rows a search leaves, in which order, and what each row says.
 */

const connection: IntegrationConnection = {
  id: "conn_gmail",
  provider: "keyring",
  vendor: "gmail",
  displayName: "Gmail",
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-api-key" },
  primaryHost: "https://gmail.googleapis.com",
  hosts: ["gmail.googleapis.com"],
  credentialSetAt: "2026-09-21T09:00:00.000Z",
  oauth: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  createdAt: "2026-09-21T09:00:00.000Z",
  updatedAt: "2026-09-21T09:00:00.000Z",
  state: "connected",
};

const row = (overrides: Partial<Integration> = {}): Integration => ({
  vendor: "gmail",
  displayName: "Gmail",
  connections: [connection],
  agents: [],
  toolCount: 0,
  lastUsedAt: null,
  needsAttention: null,
  ...overrides,
});

const claude = { id: "agt_1", name: "Claude", harness: "Claude" };
const codex = { id: "agt_2", name: "Codex", harness: "Codex" };
const hermes = { id: "agt_3", name: "Hermes", harness: null };

/** A HubSpot row whose one OAuth connection the vendor signed out. */
const signedOutConnection: IntegrationConnection = {
  ...connection,
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
    consentedAt: "2026-09-21T09:00:00.000Z",
    refreshedAt: null,
    consentRequired: { at: "2026-10-01T09:00:00.000Z", reason: "refused" },
  } as IntegrationConnection["oauth"],
  state: "consent_required",
};

const signedOut = row({
  vendor: "hubspot",
  displayName: "HubSpot",
  connections: [signedOutConnection],
  agents: [claude, codex],
  toolCount: 4,
  lastUsedAt: "2026-10-14T08:00:00.000Z",
  needsAttention: { reason: "consent_required", connectionId: "conn_hubspot" },
});

describe("readIntegrationsListSearch", () => {
  it("keeps Discover in the URL and drops anything else, so /integrations is Connected", () => {
    expect(readIntegrationsListSearch({ tab: "discover" })).toEqual({ tab: "discover" });
    expect(readIntegrationsListSearch({ tab: "connected" })).toEqual({});
    expect(readIntegrationsListSearch({ tab: 3 })).toEqual({});
    expect(readIntegrationsListSearch({})).toEqual({});
  });

  it("carries Discover's search and Flow C's hand-off only with the Discover tab", () => {
    expect(
      readIntegrationsListSearch({ tab: "discover", q: "notion", custom: "https://docs.acme.dev" }),
    ).toEqual({ tab: "discover", q: "notion", custom: "https://docs.acme.dev" });
    expect(readIntegrationsListSearch({ tab: "discover", q: "  ", custom: 4 })).toEqual({
      tab: "discover",
    });
    expect(readIntegrationsListSearch({ q: "notion", custom: "acme" })).toEqual({});
    expect(
      readIntegrationsListSearch({ tab: "discover", custom: "x".repeat(3000) }).custom,
    ).toHaveLength(2000);
  });
});

describe("readIntegrationsSort", () => {
  it("reads the three sorts and nothing else", () => {
    expect(readIntegrationsSort("attention")).toBe("attention");
    expect(readIntegrationsSort("recent")).toBe("recent");
    expect(readIntegrationsSort("name")).toBe("name");
    expect(readIntegrationsSort("paused")).toBeNull();
    expect(readIntegrationsSort(null)).toBeNull();
  });
});

describe("integrationsListOf", () => {
  const drive = row({
    vendor: "google-drive",
    displayName: "Google Drive",
    lastUsedAt: "2026-10-14T09:00:00.000Z",
  });
  const apollo = row({ vendor: "apollo", displayName: "Apollo", lastUsedAt: null });
  const sheets = row({
    vendor: "google-sheets",
    displayName: "Google Sheets",
    lastUsedAt: "2026-10-13T09:00:00.000Z",
  });
  const unfinished = row({
    vendor: "notion",
    displayName: "Notion",
    connections: [{ ...connection, id: "conn_notion", state: "awaiting_credential" }],
    needsAttention: { reason: "awaiting_credential", connectionId: "conn_notion" },
  });
  const rows = [apollo, sheets, unfinished, drive, signedOut];

  it("puts what needs the person first, worst first, then the rest newest call first", () => {
    expect(integrationsListOf(rows, { query: "", sort: "attention" }).map((r) => r.vendor)).toEqual(
      ["hubspot", "notion", "google-drive", "google-sheets", "apollo"],
    );
  });

  it("sorts by last use with a row never used last, and by name", () => {
    expect(integrationsListOf(rows, { query: "", sort: "recent" }).map((r) => r.vendor)).toEqual([
      "google-drive",
      "hubspot",
      "google-sheets",
      "apollo",
      "notion",
    ]);
    expect(integrationsListOf(rows, { query: "", sort: "name" }).map((r) => r.vendor)).toEqual([
      "apollo",
      "google-drive",
      "google-sheets",
      "hubspot",
      "notion",
    ]);
  });

  it("filters before it sorts, and leaves its input alone", () => {
    const before = [...rows];
    expect(
      integrationsListOf(rows, { query: "google sheets", sort: "name" }).map((r) => r.vendor),
    ).toEqual(["google-sheets"]);
    expect(rows).toEqual(before);
  });
});

describe("integrationMatches", () => {
  it("matches every word against the name, slug, connections, hosts and agents, ignoring case", () => {
    expect(integrationMatches(signedOut, "")).toBe(true);
    expect(integrationMatches(signedOut, "  ")).toBe(true);
    expect(integrationMatches(signedOut, "hub")).toBe(true);
    expect(integrationMatches(signedOut, "HUBAPI")).toBe(true);
    expect(integrationMatches(signedOut, "codex")).toBe(true);
    expect(integrationMatches(signedOut, "hub codex")).toBe(true);
    expect(integrationMatches(signedOut, "hub slack")).toBe(false);
  });
});

describe("attentionSentence", () => {
  it("says nothing for a row that needs nothing", () => {
    expect(attentionSentence(row())).toBeNull();
  });

  it("names who is cut off when no connection works", () => {
    expect(attentionSentence(signedOut)).toBe("Signed out, so Claude and Codex can't use it");
    expect(attentionSentence({ ...signedOut, agents: [claude] })).toBe(
      "Signed out, so Claude can't use it",
    );
    expect(attentionSentence({ ...signedOut, agents: [claude, codex, hermes] })).toBe(
      "Signed out, so 3 agents can't use it",
    );
    expect(attentionSentence({ ...signedOut, agents: [] })).toBe(
      "Signed out, so your agents can't use it",
    );
  });

  it("words each reason, the provider by its name", () => {
    const of = (
      reason: NonNullable<Integration["needsAttention"]>["reason"],
      provider = "keyring",
    ) =>
      attentionSentence({
        ...signedOut,
        connections: [{ ...signedOutConnection, provider, state: reason }],
        needsAttention: { reason, connectionId: "conn_hubspot" },
      });
    expect(of("awaiting_consent")).toBe("Sign-in not finished, so Claude and Codex can't use it");
    expect(of("awaiting_credential")).toBe(
      "No credential entered yet, so Claude and Codex can't use it",
    );
    expect(of("provider_unavailable", "acme-link")).toBe(
      "Acme link is turned off on this server, so Claude and Codex can't use it",
    );
  });

  it("names the connection when another still works", () => {
    const partial = {
      ...signedOut,
      connections: [
        { ...connection, id: "conn_work", vendor: "hubspot", displayName: "HubSpot (work)" },
        { ...signedOutConnection, displayName: "HubSpot (personal)" },
      ],
    };
    expect(attentionSentence(partial)).toBe("HubSpot (personal): signed out");
  });
});

describe("toolsCell", () => {
  it("counts the tools, and says they can't run when nothing is connected, never paused", () => {
    expect(toolsCell(row({ toolCount: 10 }))).toEqual({ text: "10", blocked: false });
    expect(toolsCell(signedOut)).toEqual({
      text: "4 can't run until you reconnect",
      blocked: true,
    });
    expect(toolsCell({ ...signedOut, toolCount: 0 })).toEqual({ text: "0", blocked: false });
  });
});

describe("usedByLabel and agentsPhrase", () => {
  it("names one agent and counts several", () => {
    expect(usedByLabel(row())).toBe("No agent");
    expect(usedByLabel(row({ agents: [claude] }))).toBe("Claude");
    expect(usedByLabel(row({ agents: [claude, codex, hermes] }))).toBe("3 agents");
    expect(agentsPhrase([claude, codex])).toBe("Claude and Codex");
  });
});

describe("integrationSubline", () => {
  it("is the address of the one connection, or how many there are", () => {
    expect(integrationSubline(row())).toBe("gmail.googleapis.com");
    expect(
      integrationSubline(row({ connections: [connection, { ...connection, id: "conn_2" }] })),
    ).toBe("2 connections");
  });
});

describe("signInOf", () => {
  it("signs in through the connection that needs the person, by its own page's way", () => {
    expect(signInOf(row())).toBeNull();
    expect(signInOf(signedOut)).toEqual({
      connection: signedOutConnection,
      action: { kind: "consent", label: "Sign in again" },
    });
    const keyed = {
      ...signedOut,
      connections: [{ ...connection, id: "conn_k", state: "awaiting_credential" as const }],
      needsAttention: { reason: "awaiting_credential" as const, connectionId: "conn_k" },
    };
    expect(signInOf(keyed)?.action).toEqual({ kind: "credential", label: "Enter credential" });
  });

  it("offers nothing where there is nothing to enter here", () => {
    const linked = {
      ...signedOut,
      connections: [{ ...signedOutConnection, provider: "acme-link", scheme: "relay" as const }],
    };
    expect(signInOf(linked)).toBeNull();
    const off = {
      ...signedOut,
      connections: [{ ...signedOutConnection, state: "provider_unavailable" as const }],
      needsAttention: { reason: "provider_unavailable" as const, connectionId: "conn_hubspot" },
    };
    expect(signInOf(off)).toBeNull();
  });
});

describe("suggestedVendorsOf and suggestedBanner", () => {
  const ask = (vendor: string, displayName: string): SuggestedIntegration => ({
    vendor,
    displayName,
    docsUrl: null,
    logoUrl: null,
    agent: { id: "agt_1", name: "Claude" },
    ask: {
      pendingActionId: `pa_${vendor}`,
      state: "declined",
      askedAt: "2026-10-13T09:00:00.000Z",
      ageSeconds: 60,
    },
  });

  it("takes each vendor once, newest first, less what is connected now", () => {
    const suggestions = [
      ask("slack", "Slack"),
      ask("notion", "Notion"),
      ask("slack", "Slack"),
      ask("gmail", "Gmail"),
    ];
    expect(suggestedVendorsOf(suggestions, [{ vendor: "gmail" }]).map((s) => s.vendor)).toEqual([
      "slack",
      "notion",
    ]);
  });

  it("says how many and spells the names, the rest as a count", () => {
    expect(suggestedBanner([])).toBeNull();
    expect(suggestedBanner([{ displayName: "Slack" }])).toEqual({
      title: "Your agents asked about an integration you haven't connected",
      names: "Slack",
    });
    expect(
      suggestedBanner(
        ["Slack", "Notion", "Linear", "Google Calendar"].map((displayName) => ({ displayName })),
      ),
    ).toEqual({
      title: "Your agents asked about 4 integrations you haven't connected",
      names: "Slack, Notion, Linear and Google Calendar",
    });
    expect(
      suggestedBanner(
        ["Slack", "Notion", "Linear", "Google Calendar", "Jira", "Asana"].map((displayName) => ({
          displayName,
        })),
      )?.names,
    ).toBe("Slack, Notion, Linear, Google Calendar and 2 more");
  });
});
