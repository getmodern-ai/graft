import type { AgentReachRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PROVIDERS } from "../connection/provider";
import type { ServiceContext } from "../context";
import type { IntegrationDeps } from "./integration.deps";
import { listIntegrations } from "./integration.service";

/** The integrations list with fakes and no database (GRA-291). */

const T0 = new Date("2026-10-01T10:00:00Z");
const T1 = new Date("2026-10-02T10:00:00Z");
const T2 = new Date("2026-10-03T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };
const ctx = { db: {} } as unknown as ServiceContext;
const executeToolName = (id: string) => `execute__${id}`;

const base: ConnectionRow = {
  id: "conn_1",
  personId: "person_1",
  provider: "keyring",
  providerRef: null,
  vendor: "gmail",
  displayName: "Gmail",
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-api-key" },
  primaryHost: "https://gmail.googleapis.com",
  hosts: ["gmail.googleapis.com"],
  credentialCiphertext: Buffer.from("c"),
  credentialSetAt: T0,
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthScopes: null,
  oauthRefreshState: null,
  providerReleaseFailedAt: null,
  account: null,
  revokedAt: null,
  owner: "person",
  createdAt: T0,
  updatedAt: T0,
};

function reach(
  agentId: string,
  connectionId: string,
  harness: string | null = null,
): AgentReachRow {
  return {
    agentId,
    agentName: `Agent ${agentId}`,
    connectedViaClientName: harness,
    connectionId,
  };
}

function fakeDeps(overrides: Partial<IntegrationDeps> = {}): IntegrationDeps {
  return {
    listConnections: vi.fn(async () => []),
    listActiveAgentReach: vi.fn(async () => []),
    countToolsByVendor: vi.fn(async () => []),
    lastUsedAtByVendor: vi.fn(async () => []),
    providers: DEFAULT_PROVIDERS,
    ...overrides,
  };
}

describe("listIntegrations", () => {
  it("gives two connections of one vendor one row, with the agents of both once each", async () => {
    const deps = fakeDeps({
      listConnections: vi.fn(async () => [
        base,
        { ...base, id: "conn_2", displayName: "Gmail (work)", createdAt: T1 },
        { ...base, id: "conn_3", vendor: "slack", displayName: "Slack" },
      ]),
      listActiveAgentReach: vi.fn(async () => [
        reach("agent_a", "conn_1", "Claude"),
        reach("agent_a", "conn_2", "Claude"),
        reach("agent_a", "conn_3", "Claude"),
        reach("agent_b", "conn_2"),
      ]),
      countToolsByVendor: vi.fn(async () => [{ vendor: "gmail", inUse: 3, offered: 3 }]),
    });
    const rows = await listIntegrations(ctx, PRINCIPAL, { executeToolName }, deps);
    expect(rows.map((row) => row.vendor)).toEqual(["gmail", "slack"]);
    const [gmail, slack] = rows;
    expect(gmail?.connections).toHaveLength(2);
    expect(gmail?.connections.map((c) => [c.id, c.state])).toEqual([
      ["conn_1", "connected"],
      ["conn_2", "connected"],
    ]);
    expect(gmail?.displayName).toBe("Gmail");
    expect(gmail?.agents).toEqual([
      { id: "agent_a", name: "Agent agent_a", harness: "Claude" },
      { id: "agent_b", name: "Agent agent_b", harness: null },
    ]);
    expect(gmail?.toolCount).toBe(3);
    expect(gmail?.inUseToolCount).toBe(3);
    expect(gmail?.needsAttention).toBeNull();
    expect(slack?.agents.map((a) => a.id)).toEqual(["agent_a"]);
    expect(slack?.toolCount).toBe(0);
    expect(slack?.inUseToolCount).toBe(0);
    expect(gmail?.connections[0]).not.toHaveProperty("credentialCiphertext");
  });

  it("issues the same four reads under the person whatever the person holds", async () => {
    const deps = fakeDeps({
      listConnections: vi.fn(async () => [base, { ...base, id: "conn_2" }]),
    });
    await listIntegrations(ctx, PRINCIPAL, { executeToolName }, deps);
    expect(deps.listConnections).toHaveBeenCalledTimes(1);
    expect(deps.listConnections).toHaveBeenCalledWith(ctx.db, "person_1");
    expect(deps.listActiveAgentReach).toHaveBeenCalledTimes(1);
    expect(deps.listActiveAgentReach).toHaveBeenCalledWith(ctx.db, "person_1");
    // Both tool counts come from one read, so a copy landing mid-read cannot split them (GRA-345).
    expect(deps.countToolsByVendor).toHaveBeenCalledTimes(1);
    expect(deps.countToolsByVendor).toHaveBeenCalledWith(ctx.db, "person_1");
    expect(deps.lastUsedAtByVendor).toHaveBeenCalledTimes(1);
    expect(deps.lastUsedAtByVendor).toHaveBeenCalledWith(ctx.db, "person_1", {
      toolNames: ["execute__conn_1", "execute__conn_2"],
    });
  });

  it("counts every tool offered, the unused stock ones beside the live ones, and the live ones as in use (GRA-345)", async () => {
    const deps = fakeDeps({
      listConnections: vi.fn(async () => [
        base,
        { ...base, id: "conn_3", vendor: "notion", displayName: "Notion" },
      ]),
      countToolsByVendor: vi.fn(async () => [
        { vendor: "gmail", inUse: 2, offered: 8 },
        { vendor: "notion", inUse: 0, offered: 7 },
        // A vendor the person has not connected has no row to count on.
        { vendor: "slack", inUse: 0, offered: 8 },
      ]),
    });
    const rows = await listIntegrations(ctx, PRINCIPAL, { executeToolName }, deps);
    expect(rows.map((row) => [row.vendor, row.toolCount, row.inUseToolCount])).toEqual([
      ["gmail", 8, 2],
      ["notion", 7, 0],
    ]);
  });

  it("leaves out revoked connections, and a vendor whose every connection is revoked", async () => {
    const deps = fakeDeps({
      listConnections: vi.fn(async () => [
        { ...base, revokedAt: T1, credentialSetAt: null },
        { ...base, id: "conn_2" },
        { ...base, id: "conn_3", vendor: "slack", revokedAt: T1 },
      ]),
      lastUsedAtByVendor: vi.fn(async () => [
        { vendor: null, toolName: "execute__conn_1", lastUsedAt: T2 },
      ]),
    });
    const rows = await listIntegrations(ctx, PRINCIPAL, { executeToolName }, deps);
    expect(rows.map((row) => row.vendor)).toEqual(["gmail"]);
    expect(rows[0]?.connections.map((c) => c.id)).toEqual(["conn_2"]);
    // A call through the revoked row's execute tool was still a call to the vendor.
    expect(rows[0]?.lastUsedAt).toEqual(T2);
    expect(deps.lastUsedAtByVendor).toHaveBeenCalledWith(ctx.db, "person_1", {
      toolNames: ["execute__conn_1", "execute__conn_2", "execute__conn_3"],
    });
  });

  it("takes the newest of the tool rows' and the execute tools' last calls", async () => {
    const deps = fakeDeps({
      listConnections: vi.fn(async () => [base, { ...base, id: "conn_3", vendor: "slack" }]),
      lastUsedAtByVendor: vi.fn(async () => [
        { vendor: "gmail", toolName: null, lastUsedAt: T1 },
        { vendor: null, toolName: "execute__conn_1", lastUsedAt: T2 },
        { vendor: null, toolName: "execute__elsewhere", lastUsedAt: T2 },
        { vendor: "slack", toolName: null, lastUsedAt: T0 },
      ]),
    });
    const rows = await listIntegrations(ctx, PRINCIPAL, { executeToolName }, deps);
    expect(rows.map((row) => [row.vendor, row.lastUsedAt])).toEqual([
      ["gmail", T2],
      ["slack", T0],
    ]);
  });

  it("answers no last call for a vendor never called", async () => {
    const deps = fakeDeps({ listConnections: vi.fn(async () => [base]) });
    const [row] = await listIntegrations(ctx, PRINCIPAL, { executeToolName }, deps);
    expect(row?.lastUsedAt).toBeNull();
    expect(row?.agents).toEqual([]);
  });

  it("flags the row with its worst connection", async () => {
    const consentRequired = {
      ...base,
      id: "conn_signed_out",
      scheme: "oauth_authorization_code" as const,
      oauthRefreshState: {
        consentedAt: T0.toISOString(),
        consentRequired: { at: T1.toISOString(), reason: "invalid_grant" },
      },
    };
    const deps = fakeDeps({
      listConnections: vi.fn(async () => [
        base,
        { ...base, id: "conn_no_key", credentialSetAt: null },
        consentRequired,
        { ...base, id: "conn_gone", provider: "broker" },
      ]),
    });
    const [row] = await listIntegrations(ctx, PRINCIPAL, { executeToolName }, deps);
    expect(row?.connections.map((c) => c.state)).toEqual([
      "connected",
      "awaiting_credential",
      "consent_required",
      "provider_unavailable",
    ]);
    expect(row?.needsAttention).toEqual({
      reason: "consent_required",
      connectionId: "conn_signed_out",
    });
  });

  it("judges a provider's row against the deployment's providers", async () => {
    const relayed = {
      ...base,
      provider: "broker",
      credentialSetAt: null,
      scheme: "relay" as const,
    };
    const withBroker = [
      ...DEFAULT_PROVIDERS,
      { name: "broker", connect: { kind: "link" as const } },
    ];
    const [enabled] = await listIntegrations(
      ctx,
      PRINCIPAL,
      { executeToolName },
      fakeDeps({ listConnections: vi.fn(async () => [relayed]), providers: withBroker }),
    );
    expect(enabled?.needsAttention).toBeNull();
    const [disabled] = await listIntegrations(
      ctx,
      PRINCIPAL,
      { executeToolName },
      fakeDeps({ listConnections: vi.fn(async () => [relayed]) }),
    );
    expect(disabled?.needsAttention).toEqual({
      reason: "provider_unavailable",
      connectionId: "conn_1",
    });
  });
});
