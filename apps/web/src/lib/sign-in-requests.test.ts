import { describe, expect, it } from "vitest";

import type { Integration, IntegrationConnection } from "./integration-queries";
import { openRequestCount, signInRequestsOf, signInRequestWhen } from "./sign-in-requests";

/** The sign-in rows at the top of Requests' Open list (GRA-313). */

const keyed: IntegrationConnection = {
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
  account: null,
  revokedAt: null,
  createdAt: "2026-09-21T09:00:00.000Z",
  updatedAt: "2026-09-21T09:00:00.000Z",
  state: "connected",
};

const refused = {
  status: "consent_required",
  consentedAt: "2026-09-21T09:00:00.000Z",
  expiresAt: null,
  refreshedAt: null,
  consentRequired: { at: "2026-10-01T09:00:00.000Z", reason: "refused" },
} satisfies NonNullable<IntegrationConnection["oauth"]>;

const signedOut: IntegrationConnection = {
  ...keyed,
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
  oauth: refused,
  state: "consent_required",
};

const claude = { id: "agt_1", name: "Claude", harness: "Claude" };
const codex = { id: "agt_2", name: "Codex", harness: "Codex" };

const row = (connections: IntegrationConnection[], overrides: Partial<Integration> = {}) =>
  ({
    vendor: connections[0]?.vendor ?? "gmail",
    displayName: connections[0]?.displayName ?? "Gmail",
    connections,
    agents: [],
    toolCount: 0,
    lastUsedAt: null,
    needsAttention: null,
    ...overrides,
  }) satisfies Integration;

describe("signInRequestsOf", () => {
  it("says who the vendor signed out and who is cut off, and signs in by consent", () => {
    const [request, ...rest] = signInRequestsOf([
      row([keyed]),
      row([signedOut], { agents: [claude, codex] }),
    ]);
    expect(rest).toEqual([]);
    expect(request).toEqual({
      key: "conn_hubspot",
      connection: signedOut,
      vendor: "hubspot",
      integrationName: "HubSpot",
      harness: "Claude",
      title: "HubSpot signed you out",
      detail: "Claude and Codex can't use HubSpot until you sign in",
      since: "2026-10-01T09:00:00.000Z",
      action: { kind: "consent", label: "Sign in again" },
    });
  });

  it("names a sign-in never finished and a credential never entered, by the right way in", () => {
    const unfinished = {
      ...signedOut,
      id: "conn_unfinished",
      oauth: { ...refused, status: "awaiting_consent", consentRequired: null },
      state: "awaiting_consent",
    } satisfies IntegrationConnection;
    const noKey = {
      ...keyed,
      credentialSetAt: null,
      state: "awaiting_credential",
    } satisfies IntegrationConnection;
    const requests = signInRequestsOf([row([noKey]), row([unfinished])]);
    expect(
      requests.map(({ title, detail, since, action }) => ({ title, detail, since, action })),
    ).toEqual([
      {
        title: "Finish signing in to HubSpot",
        detail: "Your agents can't use HubSpot until you sign in",
        since: "2026-09-21T09:00:00.000Z",
        action: { kind: "consent", label: "Connect" },
      },
      {
        title: "Finish connecting Gmail",
        detail: "Your agents can't use Gmail until you sign in",
        since: "2026-09-21T09:00:00.000Z",
        action: { kind: "credential", label: "Enter credential" },
      },
    ]);
  });

  it("puts the signed out first, then the longest waiting", () => {
    const noKey = { ...keyed, credentialSetAt: null, state: "awaiting_credential" } as const;
    const older = {
      ...signedOut,
      id: "conn_older",
      vendor: "notion",
      displayName: "Notion",
      oauth: {
        ...refused,
        consentRequired: { at: "2026-09-25T09:00:00.000Z", reason: "refused" },
      },
    } satisfies IntegrationConnection;
    expect(
      signInRequestsOf([row([noKey]), row([signedOut]), row([older])]).map((r) => r.key),
    ).toEqual(["conn_older", "conn_hubspot", "conn_gmail"]);
  });

  it("says nobody is cut off while another connection of the integration works", () => {
    const working = { ...signedOut, id: "conn_working", oauth: null, state: "connected" } as const;
    const [request] = signInRequestsOf([row([working, signedOut], { agents: [claude] })]);
    expect(request?.detail).toBe("Your other HubSpot connection still works");
  });

  it("never shows a connection whose provider is off, or one with no way in here", () => {
    const off = { ...signedOut, state: "provider_unavailable" } as const;
    const linked = { ...signedOut, provider: "acme-link", scheme: "relay" } as const;
    expect(signInRequestsOf([row([off]), row([linked])])).toEqual([]);
  });

  it("shows nothing for a revoked connection, which the read leaves out", () => {
    // `listIntegrations` drops revoked connections, and a vendor with nothing else has no row.
    expect(signInRequestsOf([])).toEqual([]);
  });
});

describe("signInRequestWhen", () => {
  it("is how long ago it started needing the person", () => {
    expect(
      signInRequestWhen(
        { since: "2026-10-01T09:00:00.000Z" },
        new Date("2026-10-01T11:00:00.000Z"),
      ),
    ).toEqual({ iso: "2026-10-01T09:00:00.000Z", label: "2 hours ago" });
    expect(signInRequestWhen({ since: "not a date" })).toBeNull();
  });
});

describe("openRequestCount", () => {
  it("counts the open asks and the sign-in rows together", () => {
    expect(openRequestCount(3, undefined)).toBe(3);
    expect(openRequestCount(3, [row([keyed]), row([signedOut])])).toBe(4);
  });
});
