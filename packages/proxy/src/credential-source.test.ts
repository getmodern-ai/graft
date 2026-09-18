import { describe, expect, it } from "vitest";

import { createDerivedCredentialCache } from "./cache";
import { credentialSource, hostSetOf, wireCredential } from "./credential-source";
import { DerivedCredentialError, SCHEMES, type SchemePlugin } from "./schemes";
import type { CredentialFields, ProxyConnection, RelayPlugin, SchemeRuntime } from "./types";

/**
 * Where the credential comes from, on its own. `app.test.ts` proves each refusal and each source
 * through the proxy; this suite pins the two seams `decide` and `forward` call — the row's
 * readiness and scope in `credentialSource`, stored against derived in `wireCredential` — and the
 * host set a row declares.
 */

const CIPHERTEXT = new Uint8Array([1, 2, 3]);
const NOW = new Date("2026-09-18T09:00:00Z");

/** A relay as a host would hand one on: enough shape for `credentialSource` to see a relay row. */
const fakeRelay: RelayPlugin = {
  kind: "relay",
  scheme: "test_relay",
  rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
  relay() {},
  headerNames: () => [],
};

function connection(overrides: Partial<ProxyConnection> = {}): ProxyConnection {
  return {
    id: "conn_1",
    personId: "person_1",
    authScheme: "api_key_header",
    primaryHost: "https://api.vendor.example/v1",
    hosts: ["api.vendor.example", "files.vendor.example"],
    schemeConfig: { headerName: "x-demo-key" },
    credentialCiphertext: CIPHERTEXT,
    ...overrides,
  };
}

const decryptCredential = async (
  ciphertext: Uint8Array,
  scope: { personId: string; connectionId: string },
): Promise<CredentialFields> => ({
  apiKey: `decrypted:${ciphertext.byteLength}:${scope.personId}:${scope.connectionId}`,
});

describe("credentialSource", () => {
  it("refuses a row with no scheme or primary host, and a row with no credential yet, as not ready", () => {
    expect(credentialSource(connection({ authScheme: null }), { decryptCredential })).toMatchObject(
      {
        kind: "refused",
        status: 409,
        reason: "connection_not_ready",
        message: "The connection has no scheme or primary host",
      },
    );
    expect(
      credentialSource(connection({ primaryHost: null }), { decryptCredential }),
    ).toMatchObject({
      reason: "connection_not_ready",
    });
    expect(
      credentialSource(connection({ credentialCiphertext: null }), { decryptCredential }),
    ).toMatchObject({
      status: 409,
      reason: "connection_not_ready",
      message: "The connection has no credential yet",
    });
  });

  it("refuses a revoked row as revoked, whatever else it carries, before its scheme, hosts or credential are read (GRA-68)", () => {
    const revoked = {
      kind: "refused",
      status: 409,
      reason: "connection_revoked",
      message: "The person revoked this connection; ask them to reconnect it in the console",
    };
    // A keyring row: the revoke cleared its ciphertext, and "no credential yet" is the wrong repair.
    expect(
      credentialSource(connection({ revokedAt: NOW, credentialCiphertext: null }), {
        decryptCredential,
      }),
    ).toMatchObject(revoked);
    // A relay row as the host hands it on: no scheme, no ciphertext and the relay withheld
    // (`toProxyConnection`), where "no scheme or primary host" named columns the row still has.
    expect(
      credentialSource(
        connection({
          revokedAt: NOW,
          authScheme: null,
          schemeConfig: null,
          credentialCiphertext: null,
        }),
        { decryptCredential },
      ),
    ).toMatchObject(revoked);
    // And a relay handed on beside the stamp: the revoke still wins.
    expect(
      credentialSource(
        connection({
          revokedAt: NOW,
          authScheme: null,
          credentialCiphertext: null,
          relay: { plugin: fakeRelay, obtain: async () => ({}) },
        }),
        { decryptCredential },
      ),
    ).toMatchObject(revoked);
    // Null is not revoked, exactly as absent.
    expect(credentialSource(connection({ revokedAt: null }), { decryptCredential })).toMatchObject({
      kind: "source",
      mode: "inject",
    });
  });

  it("names the provider that holds nothing yet for a row whose link never completed, and keeps 'no credential yet' for an unrevoked keyring row (GRA-68)", () => {
    expect(
      credentialSource(
        connection({ authScheme: null, credentialCiphertext: null, pendingProvider: "pipedream" }),
        { decryptCredential },
      ),
    ).toMatchObject({
      kind: "refused",
      status: 409,
      reason: "connection_not_ready",
      message:
        "The pipedream provider holds no account for this connection yet; the person has not finished connecting it",
    });
    expect(
      credentialSource(connection({ credentialCiphertext: null, revokedAt: null }), {
        decryptCredential,
      }),
    ).toMatchObject({
      status: 409,
      reason: "connection_not_ready",
      message: "The connection has no credential yet",
    });
  });

  it("takes scheme, primary host, host set and config from the row and decrypts under the row's scope", async () => {
    const source = credentialSource(connection(), { decryptCredential });
    expect(source).toMatchObject({
      kind: "source",
      authScheme: "api_key_header",
      primaryHost: "https://api.vendor.example/v1",
      schemeConfig: { headerName: "x-demo-key" },
    });
    if (source.kind !== "source") throw new Error("expected a source");
    expect([...source.hosts].sort()).toEqual(["api.vendor.example", "files.vendor.example"]);
    expect(await source.obtain()).toEqual({ apiKey: "decrypted:3:person_1:conn_1" });
  });

  it("defaults a missing schemeConfig to an empty record", () => {
    const source = credentialSource(connection({ schemeConfig: null }), { decryptCredential });
    expect(source).toMatchObject({ kind: "source", schemeConfig: {} });
  });

  it("names a decrypt failure the vault's word, 500, with the error on the event", () => {
    const source = credentialSource(connection(), { decryptCredential });
    if (source.kind !== "source") throw new Error("expected a source");
    const error = new Error("ciphertext is not this row's");
    expect(source.unavailable(error, 11)).toEqual({
      kind: "refused",
      status: 500,
      reason: "credential_unreadable",
      message: "The stored credential could not be decrypted",
      requestBytes: 11,
      failure: error,
    });
  });
});

/** ADR 0010's host set as the proxy compares it: declared names plus the primary's own. */
describe("hostSetOf", () => {
  it("lower-cases and trims the declared hosts", () => {
    const hosts = hostSetOf(
      connection({ hosts: [" API.Vendor.Example ", "files.vendor.example"] }),
    );
    expect([...hosts].sort()).toEqual(["api.vendor.example", "files.vendor.example"]);
  });

  it("adds the primary's hostname when the row did not list it", () => {
    const hosts = hostSetOf(connection({ hosts: ["files.vendor.example"] }));
    expect(hosts.has("api.vendor.example")).toBe(true);
    expect(hosts.has("files.vendor.example")).toBe(true);
  });

  it("adds nothing for a primary that is not a URL or is absent", () => {
    expect([...hostSetOf(connection({ hosts: ["a.example"], primaryHost: "nope" }))]).toEqual([
      "a.example",
    ]);
    expect([...hostSetOf(connection({ hosts: [], primaryHost: null }))]).toEqual([]);
  });

  it("keeps the primary's hostname without its port", () => {
    const hosts = hostSetOf(
      connection({ hosts: [], primaryHost: "https://api.vendor.example:8443" }),
    );
    expect([...hosts]).toEqual(["api.vendor.example"]);
  });
});

describe("wireCredential", () => {
  const stored: CredentialFields = { clientId: "id", clientSecret: "secret" };

  function runtime(): SchemeRuntime {
    return {
      connectionId: "conn_1",
      upstreamFetch: async () => {
        throw new Error("not called");
      },
      signal: new AbortController().signal,
      cache: createDerivedCredentialCache(),
      now: Date.now,
      once: (_key, run) => run(),
      storeCredential: async () => undefined,
    };
  }

  it("sends what the row holds when the scheme derives nothing", async () => {
    const result = await wireCredential(
      SCHEMES.bearer,
      stored,
      {},
      runtime(),
      { refresh: false },
      0,
    );
    expect(result).toEqual({ kind: "wire", credential: stored });
  });

  it("hands derive the stored credential, the config, the runtime and the refresh flag", async () => {
    const calls: { refresh: boolean; runtime: SchemeRuntime }[] = [];
    const plugin: SchemePlugin = {
      apply() {},
      headerNames: () => [],
      async derive(credential, config, rt, { refresh }) {
        calls.push({ refresh, runtime: rt });
        return { accessToken: `${credential.clientId}:${config.audience}:${refresh}` };
      },
    };
    const rt = runtime();
    const first = await wireCredential(
      plugin,
      stored,
      { audience: "a" },
      rt,
      { refresh: false },
      0,
    );
    const second = await wireCredential(
      plugin,
      stored,
      { audience: "a" },
      rt,
      { refresh: true },
      0,
    );
    expect(first).toEqual({ kind: "wire", credential: { accessToken: "id:a:false" } });
    expect(second).toEqual({ kind: "wire", credential: { accessToken: "id:a:true" } });
    expect(calls.map((call) => call.refresh)).toEqual([false, true]);
    expect(calls.every((call) => call.runtime === rt)).toBe(true);
  });

  it("turns a derive failure into the refusal deriveRefusal names", async () => {
    const plugin: SchemePlugin = {
      apply() {},
      headerNames: () => [],
      async derive() {
        throw new DerivedCredentialError(
          "The token endpoint answered 401",
          "token_exchange_failed",
          {
            upstreamStatus: 401,
          },
        );
      },
    };
    const result = await wireCredential(plugin, stored, {}, runtime(), { refresh: false }, 6);
    expect(result).toMatchObject({
      kind: "refused",
      status: 502,
      reason: "token_exchange_failed",
      requestBytes: 6,
      upstreamStatus: 401,
    });
  });

  it("lets an error that is not a derive failure propagate as the proxy's own", async () => {
    const bug = new TypeError("boom");
    const plugin: SchemePlugin = {
      apply() {},
      headerNames: () => [],
      async derive() {
        throw bug;
      },
    };
    await expect(wireCredential(plugin, stored, {}, runtime(), { refresh: false }, 0)).rejects.toBe(
      bug,
    );
  });
});
