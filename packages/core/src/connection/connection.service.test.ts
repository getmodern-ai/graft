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
  isConnectionUsable,
  markOAuthConsentRequired,
  registerConnection,
  registerConnectionWithCredential,
  revokeConnection,
  setConnectionCredential,
  startOAuthConsent,
  storeRefreshedCredential,
  toConnectionOutput,
  toProxyConnection,
} from "./connection.service";
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
    revokeConnection: vi.fn(async () => ({ ...row, revokedAt: NOW })),
    deleteApprovalsForVendor: vi.fn(async () => [{}, {}] as never),
    deleteBuildApprovalsForConnection: vi.fn(async () => [{}] as never),
    expirePendingActionsForConnection: vi.fn(async () => [{}, {}, {}] as never),
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

function linkProvider(): ConnectionProvider & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    name: "broker",
    connect: { kind: "link" },
    covers: (vendor) => vendor === "gmail",
    resolve: (r) => ({
      mode: "relay",
      relay: { plugin: fakeRelay, obtain: async () => ({ accountId: r.providerRef ?? "" }) },
    }),
    revoke: async (r) => {
      revoked.push(r.id);
    },
    revoked,
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

  it("asks the row's provider to release what it holds after a revoke, and the keyring holds nothing", async () => {
    const broker = linkProvider();
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
    expect(result?.connection.provider).toBe("broker");
    expect(broker.revoked).toEqual(["conn_1"]);

    const keyringDeps = fakeDeps({ providers: [broker, keyringProvider] });
    await revokeConnection(ctx, PRINCIPAL, "conn_1", keyringDeps);
    expect(broker.revoked).toEqual(["conn_1"]);
  });

  it("the public shape carries the provider's name", () => {
    expect(toConnectionOutput(row).provider).toBe("keyring");
    expect(toConnectionOutput({ ...row, provider: "broker" }).provider).toBe("broker");
    expect(toConnectionOutput(row)).not.toHaveProperty("providerRef");
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
      schemeConfig: { headerName: "api-auth-id" },
      credentialCiphertext: CIPHERTEXT,
    });
    expect(proxy).not.toHaveProperty("relay");
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
    });
    expect(result?.connection.revokedAt).toEqual(NOW);
  });

  it("answers null and sweeps nothing for a connection that is not the person's", async () => {
    const deps = fakeDeps({ revokeConnection: vi.fn(async () => null) });
    await expect(revokeConnection(ctx, PRINCIPAL, "conn_x", deps)).resolves.toBeNull();
    expect(deps.deleteApprovalsForVendor).not.toHaveBeenCalled();
    expect(deps.expirePendingActionsForConnection).not.toHaveBeenCalled();
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
    expect(isConnectionUsable(toConnectionOutput(oauthRow))).toBe(false);
    expect(
      isConnectionUsable(
        toConnectionOutput({ ...oauthRow, oauthRefreshState: { consentedAt: NOW.toISOString() } }),
      ),
    ).toBe(true);
  });
});
