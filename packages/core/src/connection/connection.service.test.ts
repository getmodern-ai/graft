import type { ConnectionRow } from "@graft/db/repo/connection";
import { connectionScheme } from "@graft/db/schema/connection";
import { AUTH_SCHEMES, RELAY_SCHEMES, type RelayPlugin } from "@graft/proxy";
import type { EncryptOnlyVault } from "@graft/vault";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { ConnectionDeps } from "./connection.deps";
import {
  completeOAuthConsent,
  connectThroughProvider,
  isConnectionUsable,
  markOAuthConsentRequired,
  reconnectConnection,
  registerConnection,
  registerConnectionWithCredential,
  registerProviderConnection,
  retryProviderRelease,
  revokeConnection,
  setConnectionCredential,
  startOAuthConsent,
  storeRefreshedCredential,
  toConnectionOutput,
  toProxyConnection,
  widenKeylessConnectionHosts,
  widenProviderConnectionHosts,
} from "./connection.service";
import { createGatewayProvider } from "./gateway-provider";
import { OAUTH_STATE_TTL_MS, pkceChallenge, verifyOAuthState } from "./oauth-consent";
import { type ConnectionProvider, DEFAULT_PROVIDERS, keyringProvider } from "./provider";

/**
 * The connection service with fakes and no database. The vault is a fake too — what is asserted is
 * that the fields reach it under the row's scope and reach nothing else, and that no answer carries
 * credential material (GRA-6's acceptance criterion).
 */

const NOW = new Date("2026-09-09T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };
const CIPHERTEXT = Buffer.from("ciphertext-bytes");

const row: ConnectionRow = {
  id: "conn_1",
  personId: "person_1",
  provider: "keyring",
  providerRef: null,
  vendor: "unleashed",
  displayName: "Acme Unleashed",
  scheme: "api_key_header",
  schemeConfig: { headerName: "api-auth-id" },
  primaryHost: "https://api.unleashedsoftware.com",
  hosts: ["api.unleashedsoftware.com"],
  credentialCiphertext: null,
  credentialSetAt: null,
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthScopes: null,
  oauthRefreshState: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

/** An authorization-code connection with its client secret entered and no consent yet (ADR 0005). */
const oauthRow: ConnectionRow = {
  ...row,
  id: "conn_o",
  vendor: "gmail",
  displayName: "Gmail",
  scheme: "oauth_authorization_code",
  schemeConfig: {
    clientId: "client-id",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/gmail.readonly",
  },
  primaryHost: "https://gmail.googleapis.com",
  hosts: ["gmail.googleapis.com"],
  credentialCiphertext: CIPHERTEXT,
  credentialSetAt: NOW,
};

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeVault(): EncryptOnlyVault & { encrypt: ReturnType<typeof vi.fn> } {
  return { encrypt: vi.fn(async () => CIPHERTEXT) };
}

function fakeDeps(overrides: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return {
    insertConnection: vi.fn(async (_db, input) => ({ ...row, ...input }) as ConnectionRow),
    findConnection: vi.fn(async () => row),
    findConnectionForUpdate: vi.fn(async () => row),
    findConnectionByIdUnscoped: vi.fn(async () => row),
    listConnections: vi.fn(async () => [row]),
    setConnectionCredential: vi.fn(async (_db, _p, _id, args) => ({
      ...row,
      credentialCiphertext: args.ciphertext,
      credentialSetAt: args.setAt,
      ...(args.oauthRefreshState === undefined
        ? {}
        : { oauthRefreshState: args.oauthRefreshState }),
    })),
    setConnectionOAuthState: vi.fn(async (_db, _p, _id, state) => ({
      ...row,
      oauthRefreshState: state,
    })),
    setConnectionProviderRef: vi.fn(async (_db, _p, id, providerRef) => ({
      ...row,
      id,
      providerRef,
      revokedAt: null,
      providerReleaseFailedAt: null,
    })),
    recordProviderRelease: vi.fn(async (_db, _p, _id, outcome) => ({
      ...row,
      providerRef: outcome.ref,
      revokedAt: NOW,
      ...(outcome.released
        ? { providerRef: null, providerReleaseFailedAt: null }
        : { providerReleaseFailedAt: outcome.at }),
    })),
    revokeConnection: vi.fn(async () => ({ ...row, revokedAt: NOW })),
    reconnectConnection: vi.fn(async () => ({ ...row, revokedAt: null })),
    addConnectionHosts: vi.fn(async (_db, _p, _id, hosts: string[]) => ({
      ...row,
      hosts: [...row.hosts, ...hosts.filter((host) => !row.hosts.includes(host))],
    })),
    deleteApprovalsForVendor: vi.fn(async () => [{}, {}] as never),
    deleteBuildApprovalsForConnection: vi.fn(async () => [{}] as never),
    expirePendingActionsForConnection: vi.fn(async () => [{}, {}, {}] as never),
    deleteWorkingSetEntriesForConnection: vi.fn(async () => []),
    insertWorkingSetChange: vi.fn(async (_db, input) => input as never),
    listAgentIdsForConnection: vi.fn(async () => []),
    vault: fakeVault(),
    providers: DEFAULT_PROVIDERS,
    newId: () => "conn_new",
    now: () => NOW,
    ...overrides,
  };
}

describe("the scheme enum", () => {
  /**
   * `@graft/proxy/types` promised this assertion the day GRA-6 added the table; ADR 0019 widened it
   * to the relay schemes, which a relay provider's row records as how its request leaves.
   */
  it("is the proxy's AUTH_SCHEMES and RELAY_SCHEMES, so a scheme added to one without the other fails here", () => {
    expect([...connectionScheme]).toEqual([...AUTH_SCHEMES, ...RELAY_SCHEMES]);
  });
});

/** A relay provider as GRA-58 and GRA-59 will shape one, for the branches the keyring never takes. */
const fakeRelay: RelayPlugin = {
  kind: "relay",
  scheme: "fake_relay",
  rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
  relay: () => undefined,
  headerNames: () => [],
};

function linkProvider(): ConnectionProvider & { revoked: string[]; revokedRefs: string[] } {
  const revoked: string[] = [];
  const revokedRefs: string[] = [];
  return {
    name: "broker",
    connect: {
      kind: "link",
      scheme: "relay",
      target: async (vendor) => (vendor === "gmail" ? "gmail" : null),
      start: async () => ({ url: "https://broker.example/link", expiresAt: NOW }),
      complete: async () => ({ ok: true, ref: "acct_1", label: null }),
    },
    covers: async (vendor) => vendor === "gmail",
    resolve: (r) => ({
      mode: "relay",
      relay: { plugin: fakeRelay, obtain: async () => ({ accountId: r.providerRef ?? "" }) },
    }),
    revoke: async (r) => {
      revoked.push(r.id);
      if (r.providerRef) revokedRefs.push(r.providerRef);
    },
    revoked,
    revokedRefs,
  };
}

describe("the provider a registration names (ADR 0019)", () => {
  const input = {
    vendor: "unleashed",
    displayName: "Acme",
    scheme: "api_key_header" as const,
    schemeConfig: { headerName: "api-auth-id" },
    primaryHost: "https://api.unleashedsoftware.com",
  };

  it("writes the keyring when none is named, and the named one when it is enabled and connects through the form", async () => {
    const deps = fakeDeps();
    await registerConnection(ctx, PRINCIPAL, input, deps);
    expect(deps.insertConnection).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ provider: "keyring" }),
    );
    await registerConnection(ctx, PRINCIPAL, { ...input, provider: "keyring" }, deps);
    expect(deps.insertConnection).toHaveBeenLastCalledWith(
      ctx.db,
      expect.objectContaining({ provider: "keyring" }),
    );
  });

  it("refuses a provider the deployment has not enabled, before anything is written", async () => {
    const deps = fakeDeps();
    await expect(
      registerConnection(ctx, PRINCIPAL, { ...input, provider: "broker" }, deps),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "No connection provider named broker is enabled on this deployment",
    });
    expect(deps.insertConnection).not.toHaveBeenCalled();
  });

  it("refuses to register a form connection under a provider that connects with a link", async () => {
    const deps = fakeDeps({ providers: [linkProvider(), keyringProvider] });
    await expect(
      registerConnection(ctx, PRINCIPAL, { ...input, provider: "broker" }, deps),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("connects a vendor with a link"),
    });
    await expect(
      registerConnectionWithCredential(
        ctx,
        PRINCIPAL,
        { ...input, provider: "broker", credential: { apiKey: "k" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.insertConnection).not.toHaveBeenCalled();
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
  });

  it("refuses to enter a credential on a relay provider's connection — it holds nothing here", async () => {
    const deps = fakeDeps({
      providers: [linkProvider(), keyringProvider],
      findConnection: vi.fn(async () => ({ ...row, provider: "broker", providerRef: "acct_1" })),
    });
    await expect(
      setConnectionCredential(ctx, PRINCIPAL, "conn_1", { apiKey: "k" }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
    expect(deps.setConnectionCredential).not.toHaveBeenCalled();
  });

  it("refuses to enter a credential on a none connection — it sends none (GRA-66)", async () => {
    const deps = fakeDeps({
      findConnection: vi.fn(async () => ({ ...row, scheme: "none" as const })),
    });
    await expect(
      setConnectionCredential(ctx, PRINCIPAL, "conn_1", { apiKey: "k" }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("none") });
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
    expect(deps.setConnectionCredential).not.toHaveBeenCalled();
  });

  it("registers a none connection from the form's empty credential with no ciphertext, no vault call and no transaction (GRA-66)", async () => {
    const deps = fakeDeps();
    const transaction = vi.spyOn(fakeDb, "transaction");
    const output = await registerConnectionWithCredential(
      ctx,
      PRINCIPAL,
      {
        vendor: "open-meteo",
        displayName: "Open-Meteo",
        scheme: "none",
        schemeConfig: {},
        primaryHost: "https://api.open-meteo.example",
        credential: {},
      },
      deps,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(deps.insertConnection).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ scheme: "none", vendor: "open-meteo" }),
    );
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
    expect(deps.setConnectionCredential).not.toHaveBeenCalled();
    expect(output.credentialSetAt).toBeNull();
    expect(isConnectionUsable(output)).toBe(true);
    await expect(
      registerConnectionWithCredential(
        ctx,
        PRINCIPAL,
        {
          vendor: "open-meteo",
          displayName: "Open-Meteo",
          scheme: "none",
          schemeConfig: {},
          primaryHost: "https://api.open-meteo.example",
          credential: { apiKey: "made-up" },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("asks the row's provider to release what it holds after a revoke, by the reference the revoke left in place, then forgets the reference — and the keyring holds nothing", async () => {
    const broker = linkProvider();
    const brokerRow = { ...row, provider: "broker", providerRef: "acct_1" };
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      revokeConnection: vi.fn(async () => ({ ...brokerRow, revokedAt: NOW })),
      recordProviderRelease: vi.fn(async (_db, _p, _id, outcome) => ({
        ...brokerRow,
        revokedAt: NOW,
        ...(outcome.released
          ? { providerRef: null, providerReleaseFailedAt: null }
          : { providerReleaseFailedAt: outcome.at }),
      })),
    });
    const result = await revokeConnection(ctx, PRINCIPAL, "conn_1", deps);
    expect(result?.connection.provider).toBe("broker");
    expect(result?.providerRelease).toEqual({ provider: "broker", released: true });
    expect(broker.revoked).toEqual(["conn_1"]);
    expect(broker.revokedRefs).toEqual(["acct_1"]);
    expect(deps.recordProviderRelease).toHaveBeenCalledWith(ctx.db, "person_1", "conn_1", {
      released: true,
      ref: "acct_1",
    });
    expect(result?.connection.providerReleaseFailedAt).toBeNull();

    const keyringDeps = fakeDeps({ providers: [broker, keyringProvider] });
    const keyringResult = await revokeConnection(ctx, PRINCIPAL, "conn_1", keyringDeps);
    expect(keyringResult?.providerRelease).toEqual({ provider: "keyring", released: true });
    expect(broker.revoked).toEqual(["conn_1"]);
    // Nothing to record for a row with no reference.
    expect(keyringDeps.recordProviderRelease).not.toHaveBeenCalled();
  });

  /** The release ran outside the revoke's transaction; a link may have reconnected the row meanwhile. */
  it("records the release against the reference it released, and reads the row back as it now is when that row moved on", async () => {
    const broker = linkProvider();
    const reconnected = { ...row, provider: "broker", providerRef: "acct_2", revokedAt: null };
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      revokeConnection: vi.fn(async () => ({
        ...row,
        provider: "broker",
        providerRef: "acct_1",
        revokedAt: NOW,
      })),
      // The statement matched nothing: the row is live again with another account.
      recordProviderRelease: vi.fn(async () => null),
      findConnection: vi.fn(async () => reconnected),
    });
    const result = await revokeConnection(ctx, PRINCIPAL, "conn_1", deps);
    expect(deps.recordProviderRelease).toHaveBeenCalledWith(ctx.db, "person_1", "conn_1", {
      released: true,
      ref: "acct_1",
    });
    expect(result?.providerRelease).toEqual({ provider: "broker", released: true });
    expect(result?.connection.revokedAt).toBeNull();
  });

  /** The local revoke committed before the provider was asked; its failure is a report, not a throw. */
  it("reports a provider release that failed on the result, by class name, and never fails the revoke", async () => {
    class BrokerDown extends Error {
      constructor() {
        super("account 42 at broker.example: connection refused, token sk_live_secret");
        this.name = "BrokerDown";
      }
    }
    const broker: ConnectionProvider = {
      ...linkProvider(),
      revoke: async () => {
        throw new BrokerDown();
      },
    };
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      revokeConnection: vi.fn(async () => ({
        ...row,
        provider: "broker",
        providerRef: "acct_1",
        revokedAt: NOW,
      })),
    });
    const result = await revokeConnection(ctx, PRINCIPAL, "conn_1", deps);
    expect(result?.connection.revokedAt).toEqual(NOW);
    expect(result?.approvalsDeleted).toBe(2);
    expect(result?.providerRelease).toEqual({
      provider: "broker",
      released: false,
      failure: "BrokerDown",
    });
    expect(JSON.stringify(result)).not.toContain("sk_live_secret");
    // The failure outlives the request: stamped on the row, the reference kept for the retry.
    expect(deps.recordProviderRelease).toHaveBeenCalledWith(ctx.db, "person_1", "conn_1", {
      released: false,
      ref: "acct_1",
      at: NOW,
    });
    expect(result?.connection.providerReleaseFailedAt).toEqual(NOW);
  });

  it("retries a failed release from the card: the same release, recorded the same way, and refused where nothing is outstanding", async () => {
    const broker = linkProvider();
    const failed = {
      ...row,
      provider: "broker",
      providerRef: "acct_1",
      revokedAt: NOW,
      providerReleaseFailedAt: NOW,
    };
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      findConnection: vi.fn(async () => failed),
    });
    const result = await retryProviderRelease(ctx, PRINCIPAL, "conn_1", deps);
    expect(broker.revokedRefs).toEqual(["acct_1"]);
    expect(result.providerRelease).toEqual({ provider: "broker", released: true });
    expect(deps.recordProviderRelease).toHaveBeenCalledWith(ctx.db, "person_1", "conn_1", {
      released: true,
      ref: "acct_1",
    });
    expect(result.connection.providerReleaseFailedAt).toBeNull();

    await expect(
      retryProviderRelease(
        ctx,
        PRINCIPAL,
        "conn_1",
        fakeDeps({
          providers: [broker, keyringProvider],
          findConnection: vi.fn(async () => ({ ...failed, revokedAt: null })),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("not revoked") });
    await expect(
      retryProviderRelease(
        ctx,
        PRINCIPAL,
        "conn_1",
        fakeDeps({
          providers: [broker, keyringProvider],
          findConnection: vi.fn(async () => ({
            ...failed,
            providerReleaseFailedAt: null,
            providerRef: null,
          })),
        }),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("nothing outstanding"),
    });
  });

  it("a row under a provider the deployment no longer enables revokes with nothing to release", async () => {
    const deps = fakeDeps({
      revokeConnection: vi.fn(async () => ({ ...row, provider: "gone", revokedAt: NOW })),
    });
    const result = await revokeConnection(ctx, PRINCIPAL, "conn_1", deps);
    expect(result?.providerRelease).toEqual({ provider: "gone", released: true });
  });

  it("the public shape carries the provider's name", () => {
    expect(toConnectionOutput(row).provider).toBe("keyring");
    expect(toConnectionOutput({ ...row, provider: "broker" }).provider).toBe("broker");
    expect(toConnectionOutput(row)).not.toHaveProperty("providerRef");
  });
});

describe("connectThroughProvider (ADR 0019; GRA-59)", () => {
  const input = {
    vendor: "gmail",
    displayName: "Gmail",
    primaryHost: "https://gmail.googleapis.com/gmail/v1",
    hosts: ["www.googleapis.com"],
    ref: "acct_1",
  };
  const gmailRow = {
    ...row,
    id: "conn_g",
    provider: "broker",
    vendor: "gmail",
    scheme: "relay" as const,
    schemeConfig: {},
    primaryHost: "https://gmail.googleapis.com/gmail/v1",
    hosts: ["gmail.googleapis.com", "www.googleapis.com"],
  };

  it("makes the row with the provider, its relay scheme, the reference and no credential, under the normalised host set", async () => {
    const broker = linkProvider();
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => []),
    });
    const out = await connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, deps);
    expect(deps.insertConnection).toHaveBeenCalledWith(ctx.db, {
      id: "conn_new",
      personId: "person_1",
      provider: "broker",
      providerRef: "acct_1",
      vendor: "gmail",
      displayName: "Gmail",
      scheme: "relay",
      schemeConfig: {},
      primaryHost: "https://gmail.googleapis.com/gmail/v1",
      hosts: ["gmail.googleapis.com", "www.googleapis.com"],
    });
    expect(out.credentialSetAt).toBeNull();
    expect(out).not.toHaveProperty("providerRef");
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
  });

  it("reconnects a released row of the same vendor and hosts in place, and not one whose release is still outstanding", async () => {
    const broker = linkProvider();
    const released = { ...gmailRow, providerRef: null, revokedAt: NOW };
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => [released]),
    });
    const out = await connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, deps);
    expect(deps.setConnectionProviderRef).toHaveBeenCalledWith(
      ctx.db,
      "person_1",
      "conn_g",
      "acct_1",
    );
    expect(deps.insertConnection).not.toHaveBeenCalled();
    expect(out.id).toBe("conn_g");

    const outstanding = {
      ...gmailRow,
      providerRef: "acct_old",
      revokedAt: NOW,
      providerReleaseFailedAt: NOW,
    };
    const deps2 = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => [outstanding]),
    });
    await connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, deps2);
    expect(deps2.setConnectionProviderRef).not.toHaveBeenCalled();
    expect(deps2.insertConnection).toHaveBeenCalled();
  });

  it("reconnects a released row whatever primary host and hosts the proposal names — keeping its id, primary host and name, widening its hosts to the union (GRA-122)", async () => {
    const broker = linkProvider();
    // The Gmail row as a first proposal made it: the bare API host, one host — and the proposal
    // that reconnects it names `…/gmail/v1` and a second host, as the live case did (GRA-122).
    const released = {
      ...gmailRow,
      providerRef: null,
      revokedAt: NOW,
      primaryHost: "https://gmail.googleapis.com",
      hosts: ["gmail.googleapis.com"],
    };
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => [released]),
      setConnectionProviderRef: vi.fn(async (_db, _p, id, providerRef) => ({
        ...released,
        id,
        providerRef,
        revokedAt: null,
      })),
      addConnectionHosts: vi.fn(async (_db, _p, _id, hosts: string[]) => ({
        ...released,
        providerRef: "acct_1",
        revokedAt: null,
        hosts: [...released.hosts, ...hosts.filter((host) => !released.hosts.includes(host))],
      })),
    });
    const out = await connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, deps);
    expect(deps.setConnectionProviderRef).toHaveBeenCalledWith(
      ctx.db,
      "person_1",
      "conn_g",
      "acct_1",
    );
    expect(deps.addConnectionHosts).toHaveBeenCalledWith(ctx.db, "person_1", "conn_g", [
      "gmail.googleapis.com",
      "www.googleapis.com",
    ]);
    expect(deps.insertConnection).not.toHaveBeenCalled();
    // The id every scope and every tool binding names; the primary host the proxy prepends to every
    // module path; the name the person gave it — none of them the proposal's to change.
    expect(out).toMatchObject({
      id: "conn_g",
      primaryHost: "https://gmail.googleapis.com",
      displayName: gmailRow.displayName,
      hosts: ["gmail.googleapis.com", "www.googleapis.com"],
      revokedAt: null,
    });
  });

  it("prefers the most recently revoked of several released rows, widens nothing when the union is already declared, and never touches a keyring row of the vendor", async () => {
    const broker = linkProvider();
    const older = {
      ...gmailRow,
      id: "conn_older",
      providerRef: null,
      revokedAt: new Date(NOW.getTime() - 60_000),
    };
    const newer = { ...gmailRow, id: "conn_newer", providerRef: null, revokedAt: NOW };
    // A released row of the same vendor made through the console's form: the keyring's way back is
    // a credential re-entered, and a link never reconnects it.
    const keyring = {
      ...gmailRow,
      id: "conn_keyring",
      provider: "keyring",
      scheme: "oauth_authorization_code" as const,
      providerRef: null,
      revokedAt: NOW,
    };
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => [keyring, older, newer]),
    });
    await connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, deps);
    expect(deps.setConnectionProviderRef).toHaveBeenCalledWith(
      ctx.db,
      "person_1",
      "conn_newer",
      "acct_1",
    );
    expect(deps.addConnectionHosts).not.toHaveBeenCalled();
    expect(deps.insertConnection).not.toHaveBeenCalled();

    const keyringOnly = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => [keyring]),
    });
    await connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, keyringOnly);
    expect(keyringOnly.setConnectionProviderRef).not.toHaveBeenCalled();
    expect(keyringOnly.insertConnection).toHaveBeenCalledTimes(1);
  });

  it("answers CONFLICT when the database refuses a reference another row already carries — two landings claimed one account", async () => {
    const broker = linkProvider();
    const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => []),
      insertConnection: vi.fn(async () => {
        throw new Error("wrapped", { cause: duplicate });
      }),
    });
    await expect(
      connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, deps),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("claimed the account first"),
    });
    // Any other failure of the write is the write's own.
    const other = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => []),
      insertConnection: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    });
    await expect(
      connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, other),
    ).rejects.toThrow("connection reset");
  });

  it("refuses a provider that does not connect with a link, one not enabled, an uncovered host set and an empty reference, before anything is written", async () => {
    const broker = linkProvider();
    const deps = fakeDeps({
      providers: [broker, keyringProvider],
      listConnections: vi.fn(async () => []),
    });
    await expect(
      connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: keyringProvider }, deps),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not connect a vendor with a link"),
    });
    await expect(
      connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker }, fakeDeps()),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("No connection provider named broker"),
    });
    await expect(
      connectThroughProvider(
        ctx,
        PRINCIPAL,
        { ...input, provider: broker, vendor: "notion" },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not cover"),
    });
    await expect(
      connectThroughProvider(ctx, PRINCIPAL, { ...input, provider: broker, ref: " " }, deps),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("named no account"),
    });
    expect(deps.insertConnection).not.toHaveBeenCalled();
  });
});

describe("toProxyConnection asks the row's provider how the call resolves (ADR 0019)", () => {
  it("a keyring row is the row's own columns, exactly as before providers existed", () => {
    const proxy = toProxyConnection({ ...row, credentialCiphertext: CIPHERTEXT });
    expect(proxy).toEqual({
      id: "conn_1",
      personId: "person_1",
      authScheme: "api_key_header",
      primaryHost: "https://api.unleashedsoftware.com",
      hosts: ["api.unleashedsoftware.com"],
      revokedAt: null,
      schemeConfig: { headerName: "api-auth-id" },
      credentialCiphertext: CIPHERTEXT,
    });
    expect(proxy).not.toHaveProperty("relay");
    expect(proxy).not.toHaveProperty("pendingProvider");
  });

  it("a relay provider's row carries the relay and none of the row's signing columns", async () => {
    const broker = linkProvider();
    const proxy = toProxyConnection(
      { ...row, provider: "broker", providerRef: "acct_1", credentialCiphertext: CIPHERTEXT },
      [broker, keyringProvider],
    );
    expect(proxy).toMatchObject({
      id: "conn_1",
      personId: "person_1",
      authScheme: null,
      schemeConfig: null,
      credentialCiphertext: null,
      primaryHost: "https://api.unleashedsoftware.com",
    });
    expect(proxy.relay?.plugin).toBe(fakeRelay);
    await expect(proxy.relay?.obtain()).resolves.toEqual({ accountId: "acct_1" });
  });

  it("a revoked row resolves to nothing whatever its provider — a relay row keeps its reference while the release is outstanding", () => {
    const broker = linkProvider();
    const proxy = toProxyConnection(
      {
        ...row,
        provider: "broker",
        providerRef: "acct_1",
        revokedAt: NOW,
        providerReleaseFailedAt: NOW,
      },
      [broker, keyringProvider],
    );
    expect(proxy).toMatchObject({ authScheme: null, credentialCiphertext: null, revokedAt: NOW });
    expect(proxy).not.toHaveProperty("relay");
    expect(proxy).not.toHaveProperty("pendingProvider");
  });

  it("a link provider's row that holds no reference yet resolves pending, and the proxy is told which provider holds nothing (GRA-68)", () => {
    const broker: ConnectionProvider = {
      ...linkProvider(),
      resolve: (r) =>
        r.providerRef
          ? { mode: "relay", relay: { plugin: fakeRelay, obtain: async () => ({}) } }
          : { mode: "pending" },
    };
    const pending = toProxyConnection({ ...row, provider: "broker", providerRef: null }, [
      broker,
      keyringProvider,
    ]);
    expect(pending).toMatchObject({
      authScheme: null,
      schemeConfig: null,
      credentialCiphertext: null,
      revokedAt: null,
      pendingProvider: "broker",
      primaryHost: "https://api.unleashedsoftware.com",
    });
    expect(pending).not.toHaveProperty("relay");
    // With the reference, the relay and no pending word.
    const linked = toProxyConnection({ ...row, provider: "broker", providerRef: "acct_1" }, [
      broker,
      keyringProvider,
    ]);
    expect(linked.relay?.plugin).toBe(fakeRelay);
    expect(linked).not.toHaveProperty("pendingProvider");
    // Revoked and without a reference: the revoke is read first, and the row is not pending.
    const revoked = toProxyConnection(
      { ...row, provider: "broker", providerRef: null, revokedAt: NOW },
      [broker, keyringProvider],
    );
    expect(revoked).toMatchObject({ revokedAt: NOW });
    expect(revoked).not.toHaveProperty("pendingProvider");
    expect(revoked).not.toHaveProperty("relay");
  });

  it("a row under a provider the deployment has not enabled resolves to nothing the proxy can use", () => {
    const proxy = toProxyConnection({
      ...row,
      provider: "broker",
      credentialCiphertext: CIPHERTEXT,
    });
    expect(proxy).toMatchObject({
      authScheme: null,
      schemeConfig: null,
      credentialCiphertext: null,
      primaryHost: "https://api.unleashedsoftware.com",
    });
    expect(proxy).not.toHaveProperty("relay");
  });
});

describe("registerConnection", () => {
  it("writes the normalised host set under the person, with no credential", async () => {
    const deps = fakeDeps();
    const output = await registerConnection(
      ctx,
      PRINCIPAL,
      {
        vendor: "unleashed",
        displayName: " Acme Unleashed ",
        scheme: "api_key_header",
        schemeConfig: { headerName: "api-auth-id" },
        primaryHost: "https://API.unleashedsoftware.com/",
        hosts: ["Files.unleashedsoftware.com"],
      },
      deps,
    );

    expect(deps.insertConnection).toHaveBeenCalledWith(fakeDb, {
      id: "conn_new",
      personId: "person_1",
      provider: "keyring",
      vendor: "unleashed",
      displayName: "Acme Unleashed",
      scheme: "api_key_header",
      schemeConfig: { headerName: "api-auth-id" },
      primaryHost: "https://api.unleashedsoftware.com",
      hosts: ["api.unleashedsoftware.com", "files.unleashedsoftware.com"],
    });
    expect(output.credentialSetAt).toBeNull();
    expect(output).not.toHaveProperty("credentialCiphertext");
  });

  it("refuses a private primary host, a bad scheme configuration and a bad vendor before writing", async () => {
    const deps = fakeDeps();
    const base = {
      vendor: "unleashed",
      displayName: "x",
      scheme: "api_key_header" as const,
      schemeConfig: { headerName: "x-key" },
      primaryHost: "https://api.vendor.example",
    };
    for (const input of [
      { ...base, primaryHost: "https://10.0.0.5" },
      { ...base, schemeConfig: {} },
      { ...base, vendor: "Unleashed" },
      { ...base, displayName: "" },
    ]) {
      await expect(registerConnection(ctx, PRINCIPAL, input, deps)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(deps.insertConnection).not.toHaveBeenCalled();
  });

  /** GRA-28: the reason word the form and the meta-tool show beside the sentence. */
  it("names host_not_public and the host in the refusal's details, for a primary or an additional host", async () => {
    const deps = fakeDeps();
    const base = {
      vendor: "acme",
      displayName: "Acme",
      scheme: "bearer" as const,
      primaryHost: "https://api.acme.example",
    };
    await expect(
      registerConnection(ctx, PRINCIPAL, { ...base, primaryHost: "https://169.254.169.254" }, deps),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "host_not_public", host: "169.254.169.254" },
    });
    await expect(
      registerConnection(ctx, PRINCIPAL, { ...base, hosts: ["db.internal"] }, deps),
    ).rejects.toMatchObject({ details: { reason: "host_not_public", host: "db.internal" } });
    await expect(
      registerConnection(ctx, PRINCIPAL, { ...base, primaryHost: "http://api.acme.example" }, deps),
    ).rejects.toMatchObject({ details: { reason: "invalid" } });
    expect(deps.insertConnection).not.toHaveBeenCalled();
  });

  it("stores a person-registered OAuth client's id, endpoints and scopes as the scheme's parameters — never a secret, and never without the client id", async () => {
    const deps = fakeDeps();
    const registration = {
      vendor: "gmail",
      displayName: "Gmail",
      scheme: "oauth_authorization_code" as const,
      primaryHost: "https://gmail.googleapis.com",
      schemeConfig: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
      },
    };
    // A proposal may omit the client id; a registration may not (ADR 0005).
    await expect(registerConnection(ctx, PRINCIPAL, registration, deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("clientId"),
    });

    const output = await registerConnection(
      ctx,
      PRINCIPAL,
      { ...registration, schemeConfig: { ...registration.schemeConfig, clientId: "client-id" } },
      deps,
    );
    const inserted = vi.mocked(deps.insertConnection).mock.calls[0]?.[1];
    expect(inserted?.schemeConfig).toEqual({ ...registration.schemeConfig, clientId: "client-id" });
    expect(inserted).not.toHaveProperty("oauthClientSecretCiphertext");
    expect(inserted).not.toHaveProperty("oauthClientId");
    expect(output.oauth).toEqual({
      status: "awaiting_consent",
      consentedAt: null,
      expiresAt: null,
      refreshedAt: null,
      consentRequired: null,
    });
  });
});

describe("registerConnectionWithCredential", () => {
  /** GRA-28: the console's one submit — the row and its ciphertext land together or not at all. */
  it("registers and encrypts in one transaction, and answers the public shape with credentialSetAt", async () => {
    // The read between the two writes answers the row just inserted, as the repo would.
    const deps = fakeDeps({ findConnection: vi.fn(async (_db, _p, id) => ({ ...row, id })) });
    const transaction = vi.spyOn(fakeDb, "transaction");
    const output = await registerConnectionWithCredential(
      ctx,
      PRINCIPAL,
      {
        vendor: "acme",
        displayName: "Acme",
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-api-key" },
        primaryHost: "https://api.acme.example",
        credential: { apiKey: "sk_live_1" },
      },
      deps,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deps.insertConnection).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ id: "conn_new", vendor: "acme" }),
    );
    expect(deps.vault.encrypt).toHaveBeenCalledWith(
      { apiKey: "sk_live_1" },
      { personId: "person_1", connectionId: "conn_new" },
    );
    expect(deps.setConnectionCredential).toHaveBeenCalledWith(fakeDb, "person_1", "conn_new", {
      ciphertext: CIPHERTEXT,
      setAt: NOW,
    });
    expect(output.credentialSetAt).toEqual(NOW);
    expect(JSON.stringify(output)).not.toContain("sk_live_1");
  });

  it("refuses a credential the scheme does not take before anything is written, and a private host before the vault is asked", async () => {
    const deps = fakeDeps();
    const base = {
      vendor: "acme",
      displayName: "Acme",
      scheme: "bearer" as const,
      primaryHost: "https://api.acme.example",
    };
    await expect(
      registerConnectionWithCredential(
        ctx,
        PRINCIPAL,
        { ...base, credential: { apiKey: "k" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      registerConnectionWithCredential(
        ctx,
        PRINCIPAL,
        { ...base, primaryHost: "https://10.0.0.5", credential: { token: "t" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { reason: "host_not_public" } });
    expect(deps.insertConnection).not.toHaveBeenCalled();
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
  });
});

describe("setConnectionCredential", () => {
  it("encrypts the fields under the row's person and connection id and writes the ciphertext", async () => {
    const deps = fakeDeps();
    const output = await setConnectionCredential(
      ctx,
      PRINCIPAL,
      "conn_1",
      { apiKey: "sk_live_1" },
      deps,
    );

    expect(deps.vault.encrypt).toHaveBeenCalledWith(
      { apiKey: "sk_live_1" },
      { personId: "person_1", connectionId: "conn_1" },
    );
    expect(deps.setConnectionCredential).toHaveBeenCalledWith(fakeDb, "person_1", "conn_1", {
      ciphertext: CIPHERTEXT,
      setAt: NOW,
    });
    // The fields reach the vault and nothing else.
    expect(JSON.stringify(vi.mocked(deps.setConnectionCredential).mock.calls)).not.toContain(
      "sk_live_1",
    );
    expect(output.credentialSetAt).toEqual(NOW);
    expect(JSON.stringify(output)).not.toContain("sk_live_1");
    expect(JSON.stringify(output)).not.toContain("ciphertext");
  });

  it("refuses fields the scheme does not take, before the vault is asked", async () => {
    const deps = fakeDeps();
    await expect(
      setConnectionCredential(ctx, PRINCIPAL, "conn_1", { token: "x" }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
    expect(deps.setConnectionCredential).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for another person's connection, without touching the vault", async () => {
    const deps = fakeDeps({ findConnection: vi.fn(async () => null) });
    const attempt = setConnectionCredential(ctx, PRINCIPAL, "conn_x", { apiKey: "k" }, deps);
    await expect(attempt).rejects.toThrow(ServiceError);
    await expect(attempt).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Connection not found",
    });
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
  });
});

describe("revokeConnection", () => {
  /** ADR 0007: credential, approvals and open asks go, for every agent; the tools stay. */
  it("clears the row, deletes the vendor's approvals and the connection's build approvals, and closes its open asks, in one transaction", async () => {
    const deps = fakeDeps();
    const transaction = vi.spyOn(fakeDb, "transaction");
    const result = await revokeConnection(ctx, PRINCIPAL, "conn_1", deps);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deps.revokeConnection).toHaveBeenCalledWith(fakeDb, "person_1", "conn_1", NOW);
    expect(deps.deleteApprovalsForVendor).toHaveBeenCalledWith(fakeDb, "person_1", "unleashed");
    expect(deps.deleteBuildApprovalsForConnection).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "conn_1",
    );
    // GRA-23's known edge: a destructive tool's per-call yes lives on an unconsumed action, not in a
    // row the two deletes reach — so the connection's open asks are closed under the same clock.
    expect(deps.expirePendingActionsForConnection).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "conn_1",
      NOW,
    );
    expect(result).toMatchObject({
      approvalsDeleted: 2,
      buildApprovalsDeleted: 1,
      pendingActionsExpired: 3,
      demoted: [],
      affectedAgentIds: [],
    });
    expect(result?.connection.revokedAt).toEqual(NOW);
    expect(deps.insertWorkingSetChange).not.toHaveBeenCalled();
  });

  /**
   * ADR 0009 as amended 2026-09-18 (GRA-69): a promoted tool bound to the connection leaves every
   * agent's list because it cannot run, recorded with its own cause; the tool itself is not touched.
   */
  it("demotes every agent's promoted tools bound to the connection with cause revoke, inside the transaction, and names every agent whose list changed", async () => {
    const entry = (agentId: string, toolId: string) =>
      ({ agentId, toolId, promotedAt: NOW, lastUsedAt: null, promotedBy: "agent" }) as never;
    const deps = fakeDeps({
      deleteWorkingSetEntriesForConnection: vi.fn(async () => [
        entry("agent_2", "tool_1"),
        entry("agent_1", "tool_2"),
      ]),
      // Agent 3 holds the connection in its scope with nothing promoted: its execute tool goes.
      listAgentIdsForConnection: vi.fn(async () => ["agent_1", "agent_3"]),
    });
    const transaction = vi.spyOn(fakeDb, "transaction");
    const result = await revokeConnection(ctx, PRINCIPAL, "conn_1", deps);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deps.deleteWorkingSetEntriesForConnection).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "conn_1",
    );
    expect(deps.insertWorkingSetChange).toHaveBeenCalledTimes(2);
    expect(deps.insertWorkingSetChange).toHaveBeenCalledWith(fakeDb, {
      id: "conn_new",
      agentId: "agent_2",
      toolId: "tool_1",
      change: "demote",
      cause: "revoke",
      createdAt: NOW,
    });
    expect(deps.insertWorkingSetChange).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ agentId: "agent_1", toolId: "tool_2", cause: "revoke" }),
    );
    expect(deps.listAgentIdsForConnection).toHaveBeenCalledWith(fakeDb, "person_1", "conn_1");
    expect(result?.demoted).toEqual([
      { agentId: "agent_2", toolId: "tool_1" },
      { agentId: "agent_1", toolId: "tool_2" },
    ]);
    expect(result?.affectedAgentIds).toEqual(["agent_1", "agent_2", "agent_3"]);
  });

  /**
   * A revoke of a revoked row is the release's retry: no list changes, so nobody is told (Greptile
   * on #83). The pre-read is the locking one, so two overlapping revokes cannot both see the row
   * live: the second waits for the first's commit and reads what this test hands it.
   */
  it("names no scoped agent on a second revoke of a revoked row, only the agents a demotion touched, reading the row under lock", async () => {
    const deps = fakeDeps({
      findConnectionForUpdate: vi.fn(async () => ({ ...row, revokedAt: NOW })),
      deleteWorkingSetEntriesForConnection: vi.fn(async () => [
        { agentId: "agent_2", toolId: "tool_1", promotedAt: NOW, lastUsedAt: null } as never,
      ]),
      listAgentIdsForConnection: vi.fn(async () => ["agent_1"]),
    });
    const result = await revokeConnection(ctx, PRINCIPAL, "conn_1", deps);
    expect(deps.findConnectionForUpdate).toHaveBeenCalledWith(fakeDb, "person_1", "conn_1");
    expect(deps.findConnection).not.toHaveBeenCalled();
    expect(deps.listAgentIdsForConnection).not.toHaveBeenCalled();
    expect(result?.affectedAgentIds).toEqual(["agent_2"]);
  });

  it("answers null and sweeps nothing for a connection that is not the person's", async () => {
    const deps = fakeDeps({
      findConnectionForUpdate: vi.fn(async () => null),
      revokeConnection: vi.fn(async () => null),
    });
    await expect(revokeConnection(ctx, PRINCIPAL, "conn_x", deps)).resolves.toBeNull();
    expect(deps.deleteApprovalsForVendor).not.toHaveBeenCalled();
    expect(deps.expirePendingActionsForConnection).not.toHaveBeenCalled();
    expect(deps.deleteWorkingSetEntriesForConnection).not.toHaveBeenCalled();
    expect(deps.listAgentIdsForConnection).not.toHaveBeenCalled();
  });
});

describe("the two shapes of a row", () => {
  it("the public shape carries credentialSetAt and no ciphertext or refresh state", () => {
    const output = toConnectionOutput({
      ...row,
      credentialCiphertext: CIPHERTEXT,
      credentialSetAt: NOW,
      oauthRefreshState: { refreshToken: "secret" },
    });
    expect(output.credentialSetAt).toEqual(NOW);
    expect(output).not.toHaveProperty("credentialCiphertext");
    expect(output).not.toHaveProperty("oauthClientSecretCiphertext");
    expect(output).not.toHaveProperty("oauthRefreshState");
    // A key-shaped scheme has no consent to speak of.
    expect(output.oauth).toBeNull();
  });

  it("an authorization-code row's public shape says where the consent stands and never carries the verifier", () => {
    const output = toConnectionOutput({
      ...oauthRow,
      oauthRefreshState: {
        consentedAt: "2026-09-09T09:00:00.000Z",
        expiresAt: "2026-09-09T10:00:00.000Z",
        pkce: {
          verifier: "the-verifier",
          issuedAt: "2026-09-09T08:59:00.000Z",
          pendingActionId: null,
        },
      },
    });
    expect(output.oauth).toEqual({
      status: "connected",
      consentedAt: "2026-09-09T09:00:00.000Z",
      expiresAt: "2026-09-09T10:00:00.000Z",
      refreshedAt: null,
      consentRequired: null,
    });
    expect(JSON.stringify(output)).not.toContain("the-verifier");
  });

  it("the proxy's shape is exactly what @graft/proxy declares, ciphertext included", () => {
    expect(toProxyConnection({ ...row, credentialCiphertext: CIPHERTEXT })).toEqual({
      id: "conn_1",
      personId: "person_1",
      authScheme: "api_key_header",
      primaryHost: "https://api.unleashedsoftware.com",
      hosts: ["api.unleashedsoftware.com"],
      revokedAt: null,
      schemeConfig: { headerName: "api-auth-id" },
      credentialCiphertext: CIPHERTEXT,
    });
  });
});

/**
 * The four moments of an authorization-code connection (ADR 0005), with fakes: what each writes to
 * the state and the credential, what the public shape then says, and that no answer carries a
 * token or the verifier.
 */
describe("the consent", () => {
  const SECRET = "connection-service-test-handoff-secret-32";
  const REDIRECT = "http://localhost:3000/api/oauth/callback";

  function oauthDeps(overrides: Partial<ConnectionDeps> = {}) {
    return fakeDeps({
      findConnection: vi.fn(async () => oauthRow),
      setConnectionCredential: vi.fn(async (_db, _p, _id, args) => ({
        ...oauthRow,
        credentialCiphertext: args.ciphertext,
        credentialSetAt: args.setAt,
        ...(args.oauthRefreshState === undefined
          ? {}
          : { oauthRefreshState: args.oauthRefreshState }),
      })),
      setConnectionOAuthState: vi.fn(async (_db, _p, _id, state) => ({
        ...oauthRow,
        oauthRefreshState: state,
      })),
      ...overrides,
    });
  }

  it("re-entering the client secret writes a record with no token and resets the consent state", async () => {
    const deps = oauthDeps();
    await setConnectionCredential(ctx, PRINCIPAL, "conn_o", { clientSecret: "s2" }, deps);
    expect(deps.vault.encrypt).toHaveBeenCalledWith(
      { clientSecret: "s2" },
      { personId: "person_1", connectionId: "conn_o" },
    );
    expect(deps.setConnectionCredential).toHaveBeenCalledWith(fakeDb, "person_1", "conn_o", {
      ciphertext: CIPHERTEXT,
      setAt: NOW,
      oauthRefreshState: null,
    });
    // A key-shaped scheme's re-entry leaves the column alone.
    const keyDeps = fakeDeps();
    await setConnectionCredential(ctx, PRINCIPAL, "conn_1", { apiKey: "k" }, keyDeps);
    expect(vi.mocked(keyDeps.setConnectionCredential).mock.calls[0]?.[3]).not.toHaveProperty(
      "oauthRefreshState",
    );
  });

  it("starting the consent writes a PKCE verifier and answers an authorize URL with its challenge, the redirect URI and a state signed over the connection, the person and the ask", async () => {
    const deps = oauthDeps();
    const started = await startOAuthConsent(
      ctx,
      PRINCIPAL,
      "conn_o",
      { redirectUri: REDIRECT, secret: SECRET, pendingActionId: "pa_1" },
      deps,
    );

    const written = vi.mocked(deps.setConnectionOAuthState).mock.calls[0]?.[3] as {
      pkce: { verifier: string; issuedAt: string; pendingActionId: string | null };
    };
    expect(written.pkce).toEqual({
      verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      issuedAt: NOW.toISOString(),
      pendingActionId: "pa_1",
    });

    const url = new URL(started.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(written.pkce.verifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(verifyOAuthState(url.searchParams.get("state"), SECRET, NOW)).toEqual({
      ok: true,
      payload: {
        connectionId: "conn_o",
        personId: "person_1",
        pendingActionId: "pa_1",
        expiresAt: NOW.getTime() + OAUTH_STATE_TTL_MS,
        nonce: "conn_new",
      },
    });
    expect(started.expiresAt).toEqual(new Date(NOW.getTime() + OAUTH_STATE_TTL_MS));
    expect(JSON.stringify(started.connection)).not.toContain(written.pkce.verifier);
    expect(started.connection.oauth?.status).toBe("awaiting_consent");
  });

  it("starting again keeps what is known about the consent and replaces the verifier", async () => {
    const deps = oauthDeps({
      findConnection: vi.fn(async () => ({
        ...oauthRow,
        oauthRefreshState: {
          consentedAt: "2026-09-01T10:00:00.000Z",
          consentRequired: { at: "2026-09-08T10:00:00.000Z", reason: "refused" },
          pkce: { verifier: "old", issuedAt: "x", pendingActionId: null },
        },
      })),
    });
    await startOAuthConsent(
      ctx,
      PRINCIPAL,
      "conn_o",
      { redirectUri: REDIRECT, secret: SECRET },
      deps,
    );
    const written = vi.mocked(deps.setConnectionOAuthState).mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(written.consentedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(written.consentRequired).toEqual({ at: "2026-09-08T10:00:00.000Z", reason: "refused" });
    expect((written.pkce as { verifier: string }).verifier).not.toBe("old");
    expect((written.pkce as { pendingActionId: unknown }).pendingActionId).toBeNull();
  });

  it("refuses to start before the client secret is entered, and for a scheme with no consent", async () => {
    const noSecret = oauthDeps({
      findConnection: vi.fn(async () => ({ ...oauthRow, credentialCiphertext: null })),
    });
    await expect(
      startOAuthConsent(
        ctx,
        PRINCIPAL,
        "conn_o",
        { redirectUri: REDIRECT, secret: SECRET },
        noSecret,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(noSecret.setConnectionOAuthState).not.toHaveBeenCalled();

    await expect(
      startOAuthConsent(
        ctx,
        PRINCIPAL,
        "conn_1",
        { redirectUri: REDIRECT, secret: SECRET },
        fakeDeps(),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("api_key_header"),
    });
  });

  it("completing the consent encrypts the whole record, records when and until when, and drops the verifier", async () => {
    const deps = oauthDeps({
      findConnection: vi.fn(async () => ({
        ...oauthRow,
        oauthRefreshState: { pkce: { verifier: "v", issuedAt: "x", pendingActionId: "pa_1" } },
      })),
    });
    const record = {
      clientSecret: "s",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2026-09-09T11:00:00.000Z",
    };
    const output = await completeOAuthConsent(ctx, PRINCIPAL, "conn_o", record, deps);

    expect(deps.vault.encrypt).toHaveBeenCalledWith(record, {
      personId: "person_1",
      connectionId: "conn_o",
    });
    expect(deps.setConnectionCredential).toHaveBeenCalledWith(fakeDb, "person_1", "conn_o", {
      ciphertext: CIPHERTEXT,
      setAt: NOW,
      oauthRefreshState: { consentedAt: NOW.toISOString(), expiresAt: "2026-09-09T11:00:00.000Z" },
    });
    expect(output.oauth).toEqual({
      status: "connected",
      consentedAt: NOW.toISOString(),
      expiresAt: "2026-09-09T11:00:00.000Z",
      refreshedAt: null,
      consentRequired: null,
    });
    const serialised = JSON.stringify(output);
    for (const secret of ["access-1", "refresh-1", "clientSecret", '"v"']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("refuses to complete with a record missing the access token or carrying a field from no table", async () => {
    const deps = oauthDeps();
    await expect(
      completeOAuthConsent(ctx, PRINCIPAL, "conn_o", { clientSecret: "s" }, deps),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("accessToken"),
    });
    await expect(
      completeOAuthConsent(
        ctx,
        PRINCIPAL,
        "conn_o",
        { clientSecret: "s", accessToken: "a", idToken: "i" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("idToken") });
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
  });

  it("a refresh stores the rotated record, keeps the consent's moment, clears a standing refusal, and stamps the new expiry", async () => {
    const deps = oauthDeps({
      findConnection: vi.fn(async () => ({
        ...oauthRow,
        oauthRefreshState: {
          consentedAt: "2026-09-01T10:00:00.000Z",
          expiresAt: "2026-09-09T09:00:00.000Z",
          consentRequired: { at: "2026-09-08T10:00:00.000Z", reason: "refused once" },
        },
      })),
    });
    const record = {
      clientSecret: "s",
      accessToken: "access-2",
      refreshToken: "refresh-1",
      expiresAt: "2026-09-09T11:00:00.000Z",
    };
    const output = await storeRefreshedCredential(ctx, PRINCIPAL, "conn_o", record, deps);
    expect(deps.vault.encrypt).toHaveBeenCalledWith(record, {
      personId: "person_1",
      connectionId: "conn_o",
    });
    expect(vi.mocked(deps.setConnectionCredential).mock.calls[0]?.[3]).toEqual({
      ciphertext: CIPHERTEXT,
      setAt: NOW,
      oauthRefreshState: {
        consentedAt: "2026-09-01T10:00:00.000Z",
        expiresAt: "2026-09-09T11:00:00.000Z",
        refreshedAt: NOW.toISOString(),
      },
    });
    expect(output.oauth).toMatchObject({ status: "connected", refreshedAt: NOW.toISOString() });
  });

  it("a refused refresh marks the connection for re-consent and touches no credential", async () => {
    const deps = oauthDeps({
      findConnection: vi.fn(async () => ({
        ...oauthRow,
        oauthRefreshState: { consentedAt: "2026-09-01T10:00:00.000Z" },
      })),
    });
    const output = await markOAuthConsentRequired(
      ctx,
      PRINCIPAL,
      "conn_o",
      "The stored token could not be refreshed: The token endpoint answered 400",
      deps,
    );
    expect(deps.setConnectionOAuthState).toHaveBeenCalledWith(fakeDb, "person_1", "conn_o", {
      consentedAt: "2026-09-01T10:00:00.000Z",
      consentRequired: {
        at: NOW.toISOString(),
        reason: "The stored token could not be refreshed: The token endpoint answered 400",
      },
    });
    expect(deps.setConnectionCredential).not.toHaveBeenCalled();
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
    expect(output.oauth?.status).toBe("consent_required");
    expect(isConnectionUsable(output)).toBe(false);
  });

  it("is usable only once connected: not revoked, a credential entered, and the consent complete and standing", () => {
    const base = toConnectionOutput({ ...row, credentialSetAt: NOW });
    expect(isConnectionUsable(base)).toBe(true);
    expect(isConnectionUsable({ ...base, revokedAt: NOW })).toBe(false);
    expect(isConnectionUsable({ ...base, credentialSetAt: null })).toBe(false);
    // A `none` connection never has a credential and is connected from registration (GRA-66).
    expect(isConnectionUsable(toConnectionOutput({ ...row, scheme: "none" }))).toBe(true);
    expect(isConnectionUsable(toConnectionOutput(oauthRow))).toBe(false);
    expect(
      isConnectionUsable(
        toConnectionOutput({ ...oauthRow, oauthRefreshState: { consentedAt: NOW.toISOString() } }),
      ),
    ).toBe(true);
    // A relay provider's row holds no credential here and is connected by existing (ADR 0019),
    // while the deployment enables its provider; under one it no longer enables, the proxy could
    // not call through it either (GRA-58), so the default list — the keyring alone — says no.
    const relayed = toConnectionOutput({ ...row, provider: "broker", providerRef: "acct_1" });
    const withBroker = [
      ...DEFAULT_PROVIDERS,
      { name: "broker", connect: { kind: "link" as const } },
    ];
    expect(relayed.credentialSetAt).toBeNull();
    expect(isConnectionUsable(relayed, withBroker)).toBe(true);
    expect(isConnectionUsable({ ...relayed, revokedAt: NOW }, withBroker)).toBe(false);
    expect(isConnectionUsable(relayed)).toBe(false);
  });
});

describe("a provider with no person step (ADR 0019, GRA-58)", () => {
  const gateway = createGatewayProvider({
    hosts: ["api.unleashedsoftware.com", "*.googleapis.com"],
    upstreamUrl: "https://gateway.corp.example/graft",
    headerName: "X-Deployment-Token",
    headerValue: "deployment-identity-secret-value",
  });
  const providers = [gateway, keyringProvider];
  const gatewayRow: ConnectionRow = {
    ...row,
    id: "conn_g",
    provider: "gateway",
    scheme: "gateway",
    schemeConfig: {},
    credentialCiphertext: null,
    credentialSetAt: null,
  };

  it("registers the row under the provider's name and relay scheme, with no credential and no provider_ref", async () => {
    const deps = fakeDeps({ providers, newId: () => "conn_g" });
    const output = await registerProviderConnection(
      ctx,
      PRINCIPAL,
      gateway,
      {
        vendor: "unleashed",
        displayName: "  Acme Unleashed ",
        primaryHost: "https://API.unleashedsoftware.com/",
        hosts: ["api.unleashedsoftware.com"],
      },
      deps,
    );
    expect(deps.insertConnection).toHaveBeenCalledWith(fakeDb, {
      id: "conn_g",
      personId: "person_1",
      provider: "gateway",
      providerRef: null,
      vendor: "unleashed",
      displayName: "Acme Unleashed",
      scheme: "gateway",
      schemeConfig: {},
      primaryHost: "https://api.unleashedsoftware.com",
      hosts: ["api.unleashedsoftware.com"],
    });
    expect(output).toMatchObject({ provider: "gateway", scheme: "gateway", credentialSetAt: null });
    expect(deps.vault.encrypt).not.toHaveBeenCalled();
  });

  it("refuses a form or link provider, one the deployment has not enabled, a vendor it does not cover, and a private host, before writing", async () => {
    const link = linkProvider();
    const deps = fakeDeps({ providers: [link, gateway, keyringProvider] });
    const input = {
      vendor: "unleashed",
      displayName: "Acme Unleashed",
      primaryHost: "https://api.unleashedsoftware.com",
    };
    await expect(
      registerProviderConnection(ctx, PRINCIPAL, keyringProvider, input, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /with a credential entered/ });
    await expect(
      registerProviderConnection(ctx, PRINCIPAL, link, input, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /with a link/ });
    await expect(
      registerProviderConnection(ctx, PRINCIPAL, gateway, input, fakeDeps()),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /No connection provider named gateway/,
    });
    await expect(
      registerProviderConnection(
        ctx,
        PRINCIPAL,
        gateway,
        { ...input, vendor: "acme", primaryHost: "https://api.acme.example" },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /does not cover acme at api.acme.example/,
    });
    await expect(
      registerProviderConnection(
        ctx,
        PRINCIPAL,
        gateway,
        { ...input, hosts: ["api.unleashedsoftware.com", "10.0.0.7"] },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { reason: "host_not_public" } });
    expect(deps.insertConnection).not.toHaveBeenCalled();
  });

  it("is usable by existing: no credential, not revoked, its provider enabled", () => {
    const output = toConnectionOutput(gatewayRow);
    expect(isConnectionUsable(output, providers)).toBe(true);
    expect(isConnectionUsable({ ...output, revokedAt: NOW }, providers)).toBe(false);
    // The deployment no longer enables the provider: the proxy could not call through it either.
    expect(isConnectionUsable(output)).toBe(false);
    // The keyring's rule is unchanged beside it.
    expect(
      isConnectionUsable(toConnectionOutput({ ...row, credentialSetAt: NOW }), providers),
    ).toBe(true);
    expect(isConnectionUsable(toConnectionOutput(row), providers)).toBe(false);
  });

  it("the proxy's shape carries the relay for a live row and nothing for a revoked one — a revoke has to hold with no ciphertext to clear", () => {
    const live = toProxyConnection(gatewayRow, providers);
    expect(live.relay?.plugin.scheme).toBe("gateway");
    expect(live.relay?.headerNames).toEqual(["x-deployment-token"]);
    expect(live).toMatchObject({
      authScheme: null,
      schemeConfig: null,
      credentialCiphertext: null,
      revokedAt: null,
    });
    const revoked = toProxyConnection({ ...gatewayRow, revokedAt: NOW }, providers);
    expect(revoked.relay).toBeUndefined();
    // The stamp rides with it, so the proxy refuses `connection_revoked`, not `connection_not_ready` (GRA-68).
    expect(revoked).toMatchObject({ authScheme: null, credentialCiphertext: null, revokedAt: NOW });
    // A revoked keyring row resolves the same way: its null ciphertext, and the stamp beside it.
    expect(
      toProxyConnection({ ...row, revokedAt: NOW, credentialCiphertext: null }, providers),
    ).toMatchObject({ authScheme: null, credentialCiphertext: null, revokedAt: NOW });
  });

  it("widens a keyless keyring row on the person's confirmation (GRA-167), and refuses a keyed row, a revoked row and a bad host", async () => {
    const keyless: ConnectionRow = {
      ...row,
      id: "conn_k",
      vendor: "frankfurter",
      displayName: "Frankfurter",
      scheme: "none",
      schemeConfig: {},
      primaryHost: "https://api.frankfurter.app",
      hosts: ["api.frankfurter.app"],
    };
    const deps = fakeDeps({ providers, findConnection: vi.fn(async () => keyless) });
    const output = await widenKeylessConnectionHosts(
      ctx,
      PRINCIPAL,
      "conn_k",
      ["api.frankfurter.app", "API.frankfurter.dev"],
      deps,
    );
    expect(deps.addConnectionHosts).toHaveBeenCalledWith(fakeDb, "person_1", "conn_k", [
      "api.frankfurter.app",
      "api.frankfurter.dev",
    ]);
    expect(output.id).toBe("conn_1");

    // Already declared: answered as it is, nothing written.
    const same = fakeDeps({ providers, findConnection: vi.fn(async () => keyless) });
    await widenKeylessConnectionHosts(ctx, PRINCIPAL, "conn_k", ["api.frankfurter.app"], same);
    expect(same.addConnectionHosts).not.toHaveBeenCalled();

    // A keyed row's credential would go to a host it never went to: not this function's.
    await expect(
      widenKeylessConnectionHosts(
        ctx,
        PRINCIPAL,
        "conn_1",
        ["files.unleashedsoftware.com"],
        fakeDeps({ providers, findConnection: vi.fn(async () => row) }),
      ),
    ).rejects.toThrow(/takes no credential/);
    // A revoked row's way back is Reconnect.
    await expect(
      widenKeylessConnectionHosts(
        ctx,
        PRINCIPAL,
        "conn_k",
        ["api.frankfurter.dev"],
        fakeDeps({
          providers,
          findConnection: vi.fn(async () => ({ ...keyless, revokedAt: NOW })),
        }),
      ),
    ).rejects.toThrow(/revoked/);
    // The host rule holds here as everywhere (ADR 0010).
    await expect(
      widenKeylessConnectionHosts(
        ctx,
        PRINCIPAL,
        "conn_k",
        ["169.254.169.254"],
        fakeDeps({ providers, findConnection: vi.fn(async () => keyless) }),
      ),
    ).rejects.toThrow();
  });

  it("widens a gateway row's host set to a later proposal's, within the gateway's coverage, and never a keyring row's", async () => {
    const deps = fakeDeps({ providers, findConnection: vi.fn(async () => gatewayRow) });
    const output = await widenProviderConnectionHosts(
      ctx,
      PRINCIPAL,
      gateway,
      "conn_g",
      ["Files.googleapis.com", "api.unleashedsoftware.com"],
      deps,
    );
    expect(deps.addConnectionHosts).toHaveBeenCalledWith(fakeDb, "person_1", "conn_g", [
      "api.unleashedsoftware.com",
      "files.googleapis.com",
    ]);
    expect(output.hosts).toEqual(["api.unleashedsoftware.com", "files.googleapis.com"]);

    // Already declared: answered as it is, nothing written.
    const same = fakeDeps({ providers, findConnection: vi.fn(async () => gatewayRow) });
    await widenProviderConnectionHosts(
      ctx,
      PRINCIPAL,
      gateway,
      "conn_g",
      ["api.unleashedsoftware.com"],
      same,
    );
    expect(same.addConnectionHosts).not.toHaveBeenCalled();

    // A host the gateway does not cover, a private host, and a keyring row are each refused unwritten.
    const refused = fakeDeps({ providers, findConnection: vi.fn(async () => gatewayRow) });
    await expect(
      widenProviderConnectionHosts(
        ctx,
        PRINCIPAL,
        gateway,
        "conn_g",
        ["cdn.other.example"],
        refused,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /does not cover unleashed/ });
    await expect(
      widenProviderConnectionHosts(ctx, PRINCIPAL, gateway, "conn_g", ["10.0.0.7"], refused),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { reason: "host_not_public" } });
    const keyring = fakeDeps({ providers, findConnection: vi.fn(async () => row) });
    await expect(
      widenProviderConnectionHosts(
        ctx,
        PRINCIPAL,
        gateway,
        "conn_1",
        ["files.unleashedsoftware.com"],
        keyring,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /the person's to change/ });
    expect(refused.addConnectionHosts).not.toHaveBeenCalled();
    expect(keyring.addConnectionHosts).not.toHaveBeenCalled();
  });

  it("reconnects a revoked gateway row by clearing the stamp alone, answers a live one as it is, and refuses the other kinds by naming their way back", async () => {
    const revoked = { ...gatewayRow, revokedAt: NOW };
    const deps = fakeDeps({
      providers,
      findConnection: vi.fn(async () => revoked),
      reconnectConnection: vi.fn(async () => ({ ...revoked, revokedAt: null })),
    });
    const output = await reconnectConnection(ctx, PRINCIPAL, "conn_g", deps);
    expect(deps.reconnectConnection).toHaveBeenCalledWith(fakeDb, "person_1", "conn_g");
    expect(output.revokedAt).toBeNull();
    expect(deps.setConnectionCredential).not.toHaveBeenCalled();

    const live = fakeDeps({ providers, findConnection: vi.fn(async () => gatewayRow) });
    expect((await reconnectConnection(ctx, PRINCIPAL, "conn_g", live)).revokedAt).toBeNull();
    expect(live.reconnectConnection).not.toHaveBeenCalled();

    const keyring = fakeDeps({
      providers,
      findConnection: vi.fn(async () => ({ ...row, revokedAt: NOW })),
    });
    await expect(reconnectConnection(ctx, PRINCIPAL, "conn_1", keyring)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /re-entering its credential/,
    });
    // A keyring row on `none` has no credential to re-enter, so Reconnect is its way back (GRA-66).
    const keylessRow = { ...row, scheme: "none" as const, revokedAt: NOW };
    const keyless = fakeDeps({
      providers,
      findConnection: vi.fn(async () => keylessRow),
      reconnectConnection: vi.fn(async () => ({ ...keylessRow, revokedAt: null })),
    });
    expect((await reconnectConnection(ctx, PRINCIPAL, "conn_1", keyless)).revokedAt).toBeNull();
    expect(keyless.reconnectConnection).toHaveBeenCalledWith(fakeDb, "person_1", "conn_1");
    expect(keyless.setConnectionCredential).not.toHaveBeenCalled();
    const link = linkProvider();
    const linked = fakeDeps({
      providers: [link, keyringProvider],
      findConnection: vi.fn(async () => ({ ...row, provider: "broker", revokedAt: NOW })),
    });
    await expect(reconnectConnection(ctx, PRINCIPAL, "conn_1", linked)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /through the broker provider/,
    });
    const disabled = fakeDeps({
      findConnection: vi.fn(async () => ({ ...gatewayRow, revokedAt: NOW })),
    });
    await expect(reconnectConnection(ctx, PRINCIPAL, "conn_g", disabled)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /No connection provider named gateway/,
    });
    await expect(
      reconnectConnection(
        ctx,
        PRINCIPAL,
        "conn_x",
        fakeDeps({ findConnection: vi.fn(async () => null) }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
