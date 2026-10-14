import { describe, expect, it } from "vitest";

import type { Connection } from "./connection-queries";
import {
  agentsCanUseLine,
  connectedThroughLabel,
  integrationPageOf,
  loginHolderLine,
  oauthScopesOf,
  readIntegrationSearch,
  reconnectActionsOf,
  schemeParametersOf,
} from "./integration-page";
import type { Integration, IntegrationConnection } from "./integration-queries";

/**
 * The integration page (GRA-315): one page per vendor, its live connections from the integrations
 * read and its revoked ones from the connections read, read-only once nothing is live.
 */

const base: Connection = {
  id: "conn_1",
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
};

const oauth: Connection = {
  ...base,
  id: "conn_oauth",
  scheme: "oauth_authorization_code",
  schemeConfig: {
    clientId: "client",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes:
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
  },
  oauth: {
    status: "connected",
    consentedAt: "2026-09-21T09:00:00.000Z",
    expiresAt: null,
    refreshedAt: null,
    consentRequired: null,
  },
};

const live = (connection: Connection, state: IntegrationConnection["state"] = "connected") =>
  ({ ...connection, state }) as IntegrationConnection;

const row = (overrides: Partial<Integration> = {}): Integration => ({
  vendor: "gmail",
  displayName: "Gmail",
  connections: [live(base)],
  agents: [
    { id: "agent_1", name: "Claude", harness: "Claude" },
    { id: "agent_2", name: "Hermes", harness: null },
  ],
  toolCount: 10,
  lastUsedAt: null,
  needsAttention: null,
  ...overrides,
});

describe("the page's tab in the URL", () => {
  it("keeps a tab other than the default, and drops the default and anything else", () => {
    expect(readIntegrationSearch({ tab: "connection" })).toEqual({ tab: "connection" });
    expect(readIntegrationSearch({ tab: "agents" })).toEqual({ tab: "agents" });
    expect(readIntegrationSearch({ tab: "tools" })).toEqual({});
    expect(readIntegrationSearch({ tab: "settings" })).toEqual({});
    expect(readIntegrationSearch({ tab: 3 })).toEqual({});
    expect(readIntegrationSearch({})).toEqual({});
  });
});

describe("the page for a vendor", () => {
  it("is the integrations row while a connection is live, with the header's facts off it", () => {
    const page = integrationPageOf("gmail", [row()], [base], []);
    expect(page).toMatchObject({
      kind: "integration",
      displayName: "Gmail",
      live: true,
      chip: { label: "Connected" },
      since: { verb: "connected", at: base.createdAt },
      toolCount: 10,
      agentCount: 2,
    });
  });

  it("lists every connection of the vendor, live ones first and revoked ones newest first", () => {
    const second = { ...base, id: "conn_2", createdAt: "2026-09-25T09:00:00.000Z" };
    const oldRevoke = { ...base, id: "conn_r1", revokedAt: "2026-09-01T00:00:00.000Z" };
    const newRevoke = { ...base, id: "conn_r2", revokedAt: "2026-09-10T00:00:00.000Z" };
    const other = { ...base, id: "conn_x", vendor: "slack", revokedAt: "2026-09-11T00:00:00.000Z" };
    const page = integrationPageOf(
      "gmail",
      [row({ connections: [live(base), live(second)] })],
      [base, second, oldRevoke, newRevoke, other],
      [],
    );
    if (page.kind !== "integration") throw new Error("expected the page");
    expect(page.connections.map((connection) => [connection.id, connection.state])).toEqual([
      ["conn_1", "connected"],
      ["conn_2", "connected"],
      ["conn_r2", "revoked"],
      ["conn_r1", "revoked"],
    ]);
  });

  it("wears the worst connection's chip when the row needs the person", () => {
    const signedOut = live(
      {
        ...oauth,
        oauth: {
          ...(oauth.oauth as NonNullable<Connection["oauth"]>),
          status: "consent_required",
        },
      },
      "consent_required",
    );
    const page = integrationPageOf(
      "gmail",
      [
        row({
          connections: [live(base), signedOut],
          needsAttention: { reason: "consent_required", connectionId: signedOut.id },
        }),
      ],
      [],
      [],
    );
    expect(page).toMatchObject({ chip: { label: "Needs re-consent", variant: "destructive" } });

    const gone = live({ ...base, provider: "retired" }, "provider_unavailable");
    expect(
      integrationPageOf(
        "gmail",
        [
          row({
            connections: [gone],
            needsAttention: { reason: "provider_unavailable", connectionId: gone.id },
          }),
        ],
        [],
        [],
      ),
    ).toMatchObject({ chip: { label: "Unavailable" } });
  });

  it("is read-only and drawn from the connections when every connection is revoked", () => {
    const revoked = { ...base, revokedAt: "2026-10-01T00:00:00.000Z" };
    const page = integrationPageOf(
      "gmail",
      [],
      [revoked],
      [
        { vendor: "gmail", currentVersionId: "v1" },
        { vendor: "gmail", currentVersionId: null },
        { vendor: "slack", currentVersionId: "v2" },
      ],
    );
    expect(page).toMatchObject({
      kind: "integration",
      live: false,
      chip: { label: "Revoked" },
      since: { verb: "revoked", at: "2026-10-01T00:00:00.000Z" },
      toolCount: 1,
      agentCount: 0,
    });
  });

  it("trusts the connections read's revoke while the integrations read still lists the row", () => {
    const revoked = { ...base, revokedAt: "2026-10-01T00:00:00.000Z" };
    const page = integrationPageOf("gmail", [row()], [revoked], []);
    if (page.kind !== "integration") throw new Error("expected the page");
    expect(page.live).toBe(false);
    expect(page.connections.map((connection) => connection.state)).toEqual(["revoked"]);
  });

  it("draws the connections read's live rows when the integrations read dropped the row first", () => {
    const page = integrationPageOf(
      "gmail",
      [],
      [base],
      [{ vendor: "gmail", currentVersionId: "v1" }],
    );
    expect(page).toMatchObject({
      kind: "integration",
      live: true,
      chip: { label: "Connected" },
      toolCount: 1,
      agentCount: 0,
    });
    if (page.kind !== "integration") throw new Error("expected the page");
    expect(page.connections.map((connection) => [connection.id, connection.state])).toEqual([
      ["conn_1", "connected"],
    ]);
  });

  it("is missing for a vendor the person never connected", () => {
    expect(integrationPageOf("notion", [row()], [base], [])).toEqual({ kind: "missing" });
  });
});

describe("the header's agent count", () => {
  it("reads as a sentence fragment for none, one and several", () => {
    expect(agentsCanUseLine(0)).toBe("no agent can use it");
    expect(agentsCanUseLine(1)).toBe("1 agent can use it");
    expect(agentsCanUseLine(4)).toBe("4 agents can use it");
  });
});

describe("a connection's facts", () => {
  it("names where it is connected through and who holds the login, per provider", () => {
    expect(connectedThroughLabel(base)).toBe("Graft, with a credential you entered");
    expect(connectedThroughLabel(oauth)).toBe("Graft, through OAuth");
    expect(connectedThroughLabel({ ...base, scheme: "none" })).toMatch(/no credential/);
    expect(connectedThroughLabel({ ...base, provider: "gateway", scheme: "gateway" })).toBe(
      "Your API gateway",
    );
    expect(connectedThroughLabel({ ...base, provider: "pipedream", scheme: "relay" })).toBe(
      "Pipedream",
    );

    expect(loginHolderLine(base)).toBe("Held by Graft. Never shared with agents or tools.");
    expect(loginHolderLine({ ...base, credentialSetAt: null })).toBe("Not entered yet.");
    expect(loginHolderLine({ ...base, revokedAt: "2026-10-01T00:00:00.000Z" })).toBe(
      "Cleared when it was revoked.",
    );
    expect(loginHolderLine({ ...base, provider: "pipedream", scheme: "relay" })).toMatch(
      /^Held by Pipedream\./,
    );
  });

  it("lists a keyring OAuth connection's scopes apart from its other scheme parameters", () => {
    expect(oauthScopesOf(oauth)).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(schemeParametersOf(oauth).map(([key]) => key)).toEqual([
      "clientId",
      "authorizeUrl",
      "tokenUrl",
    ]);
    expect(oauthScopesOf(base)).toEqual([]);
    expect(schemeParametersOf(base)).toEqual([["headerName", "x-api-key"]]);
  });
});

describe("the ways to sign a connection in again", () => {
  it("offers the consent and the client secret for a keyring OAuth row", () => {
    expect(reconnectActionsOf(oauth, "connected")).toEqual([
      { kind: "consent", label: "Sign in again" },
      { kind: "credential", label: "Re-enter client secret" },
    ]);
    expect(reconnectActionsOf(oauth, "awaiting_consent")[0]).toEqual({
      kind: "consent",
      label: "Connect",
    });
    expect(reconnectActionsOf({ ...oauth, credentialSetAt: null }, "awaiting_credential")).toEqual([
      { kind: "credential", label: "Enter client secret" },
    ]);
  });

  it("offers the credential dialog for a keyed row", () => {
    expect(reconnectActionsOf(base, "connected")).toEqual([
      { kind: "credential", label: "Re-enter credential" },
    ]);
    expect(reconnectActionsOf({ ...base, credentialSetAt: null }, "awaiting_credential")).toEqual([
      { kind: "credential", label: "Enter credential" },
    ]);
  });

  it("offers nothing for a revoked row, a keyless row, a gateway or a link provider", () => {
    expect(reconnectActionsOf({ ...base, revokedAt: "2026-10-01T00:00:00.000Z" })).toEqual([]);
    expect(reconnectActionsOf({ ...base, scheme: "none", credentialSetAt: null })).toEqual([]);
    expect(reconnectActionsOf({ ...base, provider: "gateway", scheme: "gateway" })).toEqual([]);
    expect(reconnectActionsOf({ ...base, provider: "pipedream", scheme: "relay" })).toEqual([]);
    expect(reconnectActionsOf(base, "provider_unavailable")).toEqual([]);
  });
});
