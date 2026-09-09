import type { ConnectionRow } from "@graft/db/repo/connection";
import { connectionScheme } from "@graft/db/schema/connection";
import { AUTH_SCHEMES } from "@graft/proxy";
import type { EncryptOnlyVault } from "@graft/vault";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { ConnectionDeps } from "./connection.deps";
import {
  registerConnection,
  registerConnectionWithCredential,
  revokeConnection,
  setConnectionCredential,
  toConnectionOutput,
  toProxyConnection,
} from "./connection.service";

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
    })),
    revokeConnection: vi.fn(async () => ({ ...row, revokedAt: NOW })),
    deleteApprovalsForVendor: vi.fn(async () => [{}, {}] as never),
    deleteBuildApprovalsForConnection: vi.fn(async () => [{}] as never),
    expirePendingActionsForConnection: vi.fn(async () => [{}, {}, {}] as never),
    vault: fakeVault(),
    newId: () => "conn_new",
    now: () => NOW,
    ...overrides,
  };
}

describe("the scheme enum", () => {
  /** `@graft/proxy/types` promised this assertion the day GRA-6 added the table. */
  it("is the proxy's AUTH_SCHEMES, so a scheme added to one without the other fails here", () => {
    expect([...connectionScheme]).toEqual([...AUTH_SCHEMES]);
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

  it("stores a person-registered OAuth client's id, endpoints and scopes — never a secret", async () => {
    const deps = fakeDeps();
    await registerConnection(
      ctx,
      PRINCIPAL,
      {
        vendor: "gmail",
        displayName: "Gmail",
        scheme: "bearer",
        primaryHost: "https://gmail.googleapis.com",
        oauth: {
          clientId: "client-id",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      },
      deps,
    );
    const inserted = vi.mocked(deps.insertConnection).mock.calls[0]?.[1];
    expect(inserted).toMatchObject({
      oauthClientId: "client-id",
      oauthAuthorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      oauthTokenUrl: "https://oauth2.googleapis.com/token",
      oauthScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    expect(inserted).not.toHaveProperty("oauthClientSecretCiphertext");
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
