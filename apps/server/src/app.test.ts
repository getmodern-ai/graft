import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGatewayProvider, keyringProvider, toProxyConnection } from "@graft/core";
import type { ConnectionRow } from "@graft/db/repo/connection";
import { PROXY_MAX_BODY_BYTES_DEFAULT, serverSchema } from "@graft/env/schema";
import {
  createUpstreamFetch,
  DEFAULT_PROXY_OPTIONS,
  DRY_RUN_HEADER,
  type ProxyEvent,
  type UpstreamRequest,
} from "@graft/proxy";
import type { ResolveAll } from "@graft/proxy/upstream";
import {
  CAPABILITY_TOKEN_ALG,
  type CapabilityTokenKeys,
  importCapabilityTokenKeys,
  mintCapabilityToken,
} from "@graft/token";
import { createCredentialVault, createLocalKeyring } from "@graft/vault";
import { initLogger } from "evlog";
import { decodeProtectedHeader, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer, proxyBodyCapClause, type ServerDeps } from "./app";
import { type ConnectionSeed, createInMemoryConnections, seedConnections } from "./connections";

/**
 * The proxy with the real halves its own package cannot hold — GRA-5's acceptance criterion at this
 * seam: the server's app through `app.request()`, a key pair generated for the test, the real vault
 * over the local keyring, the in-memory store seeded the way `index.ts` seeds it, and a fake
 * upstream that records what reached it. The proxy package's own suite covers the mechanics against
 * fakes; this is the proof that the real verifier and the real vault plug into the same seams and
 * behave, end to end, as GRA-1 says.
 */

// The request logger would otherwise print one line per test request.
initLogger({ silent: true });

const SECRET = "test-secret-that-is-long-enough-32";
const PERSON = "person_1";
const AGENT = "agent_1";
const API_KEY = "sk_live_the_real_vendor_key";

const vault = createCredentialVault(createLocalKeyring(SECRET));

const SEED: ConnectionSeed = {
  id: "conn_1",
  personId: PERSON,
  authScheme: "api_key_header",
  primaryHost: "https://api.demo.example/v2",
  hosts: ["files.demo.example"],
  schemeConfig: { headerName: "x-demo-key" },
  credential: { apiKey: API_KEY },
};

let keys: CapabilityTokenKeys;

beforeAll(async () => {
  const pair = await generateKeyPair(CAPABILITY_TOKEN_ALG, { crv: "Ed25519", extractable: true });
  keys = await importCapabilityTokenKeys({
    privateKeyPem: await exportPKCS8(pair.privateKey),
    publicKeyPem: await exportSPKI(pair.publicKey),
  });
});

async function harness(overrides: Partial<ServerDeps> = {}) {
  const events: ProxyEvent[] = [];
  const forwarded: UpstreamRequest[] = [];
  const connections = createInMemoryConnections();
  await seedConnections(connections, vault, [SEED]);
  // A ciphertext minted for `conn_1`, sitting on `conn_2`'s row — the vault must refuse it.
  const first = await connections.get("conn_1");
  if (first) connections.put({ ...first, id: "conn_2" });

  const app = createServer({
    keys,
    vault,
    connections,
    followRedirects: false,
    upstreamFetch: async (request) => {
      forwarded.push(request);
      return new Response('{"echo":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    log: (event) => events.push(event),
    ...overrides,
  });
  return { app, events, forwarded, connections };
}

const mint = (overrides: Partial<Parameters<typeof mintCapabilityToken>[0]> = {}, now?: Date) =>
  mintCapabilityToken(
    {
      personId: PERSON,
      agentId: AGENT,
      connectionIds: ["conn_1", "conn_2"],
      tool: "execute",
      ttlSeconds: 300,
      ...overrides,
    },
    keys,
    now,
  );

describe("the server", () => {
  it("answers OK at the root, for a health check", async () => {
    const h = await harness();
    const res = await h.app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  /** The mount-order rule `app.ts` states: nothing answers a preflight ahead of the proxy. */
  it("lets an OPTIONS reach the proxy rather than answering it as a preflight", async () => {
    const h = await harness();
    const res = await h.app.request("/api/proxy/c/conn_1/items", {
      method: "OPTIONS",
      headers: { origin: "https://console.graft.example" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "token_missing" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the proxy with the real verifier and the real vault", () => {
  it.each([
    ["Authorization: Bearer", (t: string) => ({ authorization: `Bearer ${t}` })],
    ["Authorization: raw", (t: string) => ({ authorization: t })],
    [
      "Authorization: Basic",
      (t: string) => ({ authorization: `Basic ${Buffer.from(`${t}:`).toString("base64")}` }),
    ],
    ["x-api-key", (t: string) => ({ "x-api-key": t })],
    ["x-graft-token", (t: string) => ({ "x-graft-token": t })],
  ])(
    "a minted token in %s reaches the vendor with the decrypted key injected",
    async (_position, headers) => {
      const h = await harness();
      const token = await mint();
      const res = await h.app.request("/api/proxy/c/conn_1/items?limit=2", {
        headers: headers(token),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ echo: true });
      const sent = h.forwarded[0];
      expect(sent?.url).toBe("https://api.demo.example/v2/items?limit=2");
      expect(sent?.headers.get("x-demo-key")).toBe(API_KEY);
      expect(sent?.headers.get("authorization")).toBeNull();
      expect(sent?.headers.get("x-api-key")).toBeNull();
      expect(sent?.headers.get("x-graft-token")).toBeNull();
      expect(JSON.stringify([...(sent?.headers.entries() ?? [])])).not.toContain(token);
      expect(h.events[0]).toMatchObject({
        outcome: "forwarded",
        connectionId: "conn_1",
        personId: PERSON,
        agentId: AGENT,
        tool: "execute",
        host: "api.demo.example",
        path: "/items",
      });
      expect(JSON.stringify(h.events)).not.toContain(API_KEY);
      expect(JSON.stringify(h.events)).not.toContain(token);
    },
  );

  it("reaches a declared secondary host through the explicit form", async () => {
    const h = await harness();
    const res = await h.app.request("/api/proxy/c/conn_1/h/files.demo.example/blobs/1", {
      headers: { authorization: `Bearer ${await mint()}` },
    });

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.url).toBe("https://files.demo.example/blobs/1");
    expect(h.forwarded[0]?.headers.get("x-demo-key")).toBe(API_KEY);
    expect(h.events[0]).toMatchObject({ host: "files.demo.example", path: "/blobs/1" });

    const refused = await h.app.request("/api/proxy/c/conn_1/h/evil.example/blobs/1", {
      headers: { authorization: `Bearer ${await mint()}` },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "host_not_in_set" });
    expect(h.forwarded).toHaveLength(1);
  });

  /**
   * The dry run end to end with the real minter and verifier: the claim minted here is the claim the
   * proxy reads, a write stops with the preview and never touches the vault or the vendor, and a
   * read goes through with the decrypted key injected and comes back marked.
   */
  it("a dry-run token stops a write with the preview and lets a read through, marked", async () => {
    const h = await harness();
    const token = await mint({ dryRun: true });

    const write = await h.app.request("/api/proxy/c/conn_1/items", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: '{"name":"widget"}',
    });
    expect(write.status).toBe(202);
    expect(write.headers.get(DRY_RUN_HEADER)).toBe("intercepted");
    expect(await write.json()).toEqual({
      dryRun: true,
      intercepted: true,
      request: {
        method: "POST",
        host: "api.demo.example",
        path: "/v2/items",
        hasQuery: false,
        headerNames: ["accept-encoding", "content-type", "x-demo-key"],
        bodyBytes: 17,
        body: '{"name":"widget"}',
        bodyEncoding: "utf-8",
      },
    });
    expect(h.forwarded).toHaveLength(0);

    const read = await h.app.request("/api/proxy/c/conn_1/items?limit=1", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get(DRY_RUN_HEADER)).toBe("forwarded");
    expect(await read.json()).toEqual({ echo: true });
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]?.headers.get("x-demo-key")).toBe(API_KEY);

    expect(h.events.map((e) => [e.outcome, e.dryRun, e.dryRunOutcome])).toEqual([
      ["dry_run_intercepted", true, "intercepted"],
      ["forwarded", true, "forwarded"],
    ]);
    expect(JSON.stringify(h.events)).not.toContain(API_KEY);
  });

  it("refuses a token that has expired", async () => {
    const h = await harness();
    const stale = await mint({}, new Date(Date.now() - 20 * 60 * 1000));
    const res = await h.app.request("/api/proxy/c/conn_1/items", {
      headers: { authorization: `Bearer ${stale}` },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "token_expired" });
    expect(h.forwarded).toHaveLength(0);
  });

  it("refuses a token minted for another person, and one whose scope does not name the connection", async () => {
    const h = await harness();
    const otherPerson = await mint({ personId: "person_2" });
    const otherScope = await mint({ agentId: "agent_2", connectionIds: ["conn_9"] });

    const a = await h.app.request("/api/proxy/c/conn_1/items", {
      headers: { authorization: `Bearer ${otherPerson}` },
    });
    const b = await h.app.request("/api/proxy/c/conn_1/items", {
      headers: { authorization: `Bearer ${otherScope}` },
    });

    expect(a.status).toBe(403);
    expect(await a.json()).toMatchObject({ reason: "person_mismatch" });
    expect(b.status).toBe(403);
    expect(await b.json()).toMatchObject({ reason: "connection_not_in_token" });
    expect(h.forwarded).toHaveLength(0);
    expect(h.events[1]).toMatchObject({ agentId: "agent_2", outcome: "connection_not_in_token" });
  });

  it("refuses a token signed by a key the deployment does not hold", async () => {
    const h = await harness();
    const stranger = await generateKeyPair(CAPABILITY_TOKEN_ALG, {
      crv: "Ed25519",
      extractable: true,
    });
    const forged = await mintCapabilityToken(
      {
        personId: PERSON,
        agentId: AGENT,
        connectionIds: ["conn_1"],
        tool: "execute",
        ttlSeconds: 300,
      },
      await importCapabilityTokenKeys({
        privateKeyPem: await exportPKCS8(stranger.privateKey),
        publicKeyPem: await exportSPKI(stranger.publicKey),
      }),
    );
    const res = await h.app.request("/api/proxy/c/conn_1/items", {
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "token_invalid" });
  });

  /** The vault's encryption context, doing its job through the proxy's seam. */
  it("refuses a ciphertext that was minted for another row", async () => {
    const h = await harness();
    const res = await h.app.request("/api/proxy/c/conn_2/items", {
      headers: { authorization: `Bearer ${await mint()}` },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ reason: "credential_unreadable" });
    expect(h.events[0]?.failure).toContain("CredentialScopeMismatchError");
    expect(h.forwarded).toHaveLength(0);
  });

  it("publishes the verification key the minted token's kid points into", async () => {
    const h = await harness();
    const res = await h.app.request("/api/proxy/.well-known/jwks.json");
    const jwks = (await res.json()) as { keys: { kid: string; crv: string }[] };

    expect(res.status).toBe(200);
    expect(jwks.keys[0]?.crv).toBe("Ed25519");
    expect(decodeProtectedHeader(await mint()).kid).toBe(jwks.keys[0]?.kid);
  });

  it("answers 503 on both routes when the deployment has no key pair", async () => {
    const h = await harness({ keys: null });
    const call = await h.app.request("/api/proxy/c/conn_1/items", {
      headers: { authorization: `Bearer ${await mint()}` },
    });
    const jwks = await h.app.request("/api/proxy/.well-known/jwks.json");

    expect(call.status).toBe(503);
    expect(await call.json()).toMatchObject({ reason: "proxy_unconfigured" });
    expect(jwks.status).toBe(503);
  });
});

/**
 * The body cap is the environment's (GRA-183): what `index.ts` reads from `GRAFT_PROXY_MAX_BODY_BYTES`
 * reaches the proxy's options, the refusal quotes it, the two defaults are one figure, and the boot
 * line names the cap only when an operator raised it.
 */
describe("the proxy's body cap from the environment (GRA-183)", () => {
  it("is the same ten mebibytes in @graft/env and in @graft/proxy", () => {
    expect(serverSchema.GRAFT_PROXY_MAX_BODY_BYTES.parse(undefined)).toBe(
      DEFAULT_PROXY_OPTIONS.maxBodyBytes,
    );
    expect(PROXY_MAX_BODY_BYTES_DEFAULT).toBe(DEFAULT_PROXY_OPTIONS.maxBodyBytes);
  });

  it("reaches the proxy and is quoted in the request leg's refusal", async () => {
    const h = await harness({ maxBodyBytes: 1024 * 1024 });
    const res = await h.app.request("/api/proxy/c/conn_1/items", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await mint()}`,
        "content-length": String(1024 * 1024 + 1),
      },
      body: "x",
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "payload_too_large",
      reason: "request_too_large",
      message: `Request bodies are capped at ${1024 * 1024} bytes`,
    });
    expect(h.forwarded).toHaveLength(0);
  });

  it("runs on the proxy's default when the harness passes nothing", async () => {
    const h = await harness();
    const res = await h.app.request("/api/proxy/c/conn_1/items", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await mint()}`,
        "content-length": String(DEFAULT_PROXY_OPTIONS.maxBodyBytes + 1),
      },
      body: "x",
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      message: `Request bodies are capped at ${DEFAULT_PROXY_OPTIONS.maxBodyBytes} bytes`,
    });
  });

  it("is named on the boot line when raised, in mebibytes or bytes, and not at the default", () => {
    expect(proxyBodyCapClause(DEFAULT_PROXY_OPTIONS.maxBodyBytes)).toBe("");
    expect(proxyBodyCapClause(64 * 1024 * 1024)).toBe(", proxy body cap 64 MiB");
    expect(proxyBodyCapClause(20 * 1024 * 1024)).toBe(", proxy body cap 20 MiB");
    expect(proxyBodyCapClause(15_000_000)).toBe(", proxy body cap 15000000 bytes");
    expect(proxyBodyCapClause(1024 * 1024)).toBe(", proxy body cap 1 MiB");
  });
});

describe("the seed", () => {
  it("adds the primary's hostname to the host set and encrypts the credential", async () => {
    const store = createInMemoryConnections();
    await seedConnections(store, vault, [SEED]);
    const row = await store.get("conn_1");

    expect(row).toMatchObject({
      id: "conn_1",
      personId: PERSON,
      authScheme: "api_key_header",
      primaryHost: "https://api.demo.example/v2",
      hosts: ["api.demo.example", "files.demo.example"],
      schemeConfig: { headerName: "x-demo-key" },
    });
    expect(row?.credentialCiphertext).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(row?.credentialCiphertext ?? []).includes(Buffer.from(API_KEY))).toBe(false);
    expect(
      await vault.decrypt(row?.credentialCiphertext ?? new Uint8Array(), {
        personId: PERSON,
        connectionId: "conn_1",
      }),
    ).toEqual({ apiKey: API_KEY });
  });

  it("refuses a credential whose fields are not the scheme's, naming them", async () => {
    const store = createInMemoryConnections();
    await expect(
      seedConnections(store, vault, [{ ...SEED, credential: { token: "t" } }]),
    ).rejects.toThrow(/missing \[apiKey\], unknown \[token\]/);
    await expect(
      seedConnections(store, vault, [
        {
          ...SEED,
          authScheme: "snowflake_keypair_jwt",
          credential: { privateKey: "k", privateKeyPassphrase: "p" },
        },
      ]),
    ).resolves.toBeUndefined();
    expect(store.ids()).toEqual(["conn_1"]);
  });
});

/**
 * A connection through a company's API gateway (ADR 0019, GRA-58), end to end at this seam: the
 * real verifier, the real provider's resolution of a database-shaped row, and the real
 * `createUpstreamFetch` twice over — the relay leg's own, with the gateway's hostname exempt from the
 * address guard, as `backings.ts` builds it, and the proxy's shared one with no exemption at all. The
 * gateway has a public-looking name, `gateway.corp.example`, that a scripted resolver answers with
 * the loopback the fake listens on — the enterprise shape, an internal address behind a real name —
 * so the guard's verdict is the one under test: lifted for the relay, kept for a keyring connection
 * an agent proposed at that same name.
 */
describe("a gateway connection through the server", () => {
  const IDENTITY = "deployment-identity-secret-value";
  const GATEWAY_NAME = "gateway.corp.example";
  const gatewayRow: ConnectionRow = {
    id: "conn_g",
    personId: PERSON,
    provider: "gateway",
    providerRef: null,
    providerReleaseFailedAt: null,
    vendor: "demo",
    displayName: "Demo through the gateway",
    scheme: "gateway",
    schemeConfig: {},
    primaryHost: "https://api.demo.example/v2",
    hosts: ["api.demo.example"],
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
    createdAt: new Date("2026-09-17T09:00:00Z"),
    updatedAt: new Date("2026-09-17T09:00:00Z"),
  };
  let gateway: Server;
  let gatewayUrl: string;
  const seen: { url: string; identity: string | undefined }[] = [];
  /** The gateway's name resolves to the loopback the fake listens on; nothing else resolves. */
  const resolveAll: ResolveAll = (hostname, callback) => {
    if (hostname === GATEWAY_NAME) return callback(null, [{ address: "127.0.0.1", family: 4 }]);
    callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), []);
  };

  beforeAll(async () => {
    gateway = createHttpServer((req, res) => {
      seen.push({ url: req.url ?? "", identity: req.headers["x-deployment-token"] as string });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"gateway":true}');
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", () => resolve()));
    gatewayUrl = `http://${GATEWAY_NAME}:${(gateway.address() as AddressInfo).port}/graft`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });

  async function gatewayHarness(row: ConnectionRow, relayExempt: boolean) {
    const provider = createGatewayProvider({
      hosts: ["api.demo.example"],
      upstreamUrl: gatewayUrl,
      headerName: "X-Deployment-Token",
      headerValue: IDENTITY,
      ...(relayExempt
        ? { upstreamFetch: createUpstreamFetch({ resolveAll, unguardedHosts: [GATEWAY_NAME] }) }
        : {}),
    });
    // The proxy's shared fetch: the guard, and never an exemption.
    const h = await harness({ upstreamFetch: createUpstreamFetch({ resolveAll }) });
    h.connections.put(toProxyConnection(row, [provider, keyringProvider]));
    return h;
  }

  it("relays a minted token's call through the gateway with the identity header and the vendor URL in the path", async () => {
    const h = await gatewayHarness(gatewayRow, true);
    const token = await mint({ connectionIds: ["conn_g"] });
    const res = await h.app.request("/api/proxy/c/conn_g/items?limit=2", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gateway: true });
    expect(seen.at(-1)).toEqual({
      url: "/graft/api.demo.example/v2/items?limit=2",
      identity: IDENTITY,
    });
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      relay: "gateway",
      host: "api.demo.example",
      path: "/items",
      connectionId: "conn_g",
    });
    expect(JSON.stringify(h.events)).not.toContain(IDENTITY);
  });

  it("the exemption is the relay leg's alone: a keyring connection at the gateway's name is still refused on its resolved address, and a relay with no fetch of its own is too", async () => {
    const h = await gatewayHarness(gatewayRow, true);
    const port = (gateway.address() as AddressInfo).port;
    // An agent proposed the gateway's public-looking name as a vendor host, and the person entered a
    // key for it: the literal check passes, the resolver's must not — the decrypted key would go to a
    // private address (Greptile on #45).
    h.connections.put({
      id: "conn_k",
      personId: PERSON,
      authScheme: "api_key_header",
      primaryHost: `https://${GATEWAY_NAME}:${port}`,
      hosts: [GATEWAY_NAME],
      schemeConfig: { headerName: "x-demo-key" },
      credentialCiphertext: await vault.encrypt(
        { apiKey: API_KEY },
        { personId: PERSON, connectionId: "conn_k" },
      ),
    });
    const before = seen.length;
    const token = await mint({ connectionIds: ["conn_g", "conn_k"] });
    const keyring = await h.app.request("/api/proxy/c/conn_k/items", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(keyring.status).toBe(403);
    expect(await keyring.json()).toMatchObject({ reason: "host_not_public" });
    expect(seen).toHaveLength(before);

    const unexempt = await gatewayHarness(gatewayRow, false);
    const relay = await unexempt.app.request("/api/proxy/c/conn_g/items", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(relay.status).toBe(403);
    expect(await relay.json()).toMatchObject({ reason: "host_not_public" });
    expect(seen).toHaveLength(before);
  });

  it("a revoked row is refused as revoked, whatever its provider: the binding carries the stamp through toProxyConnection (GRA-68)", async () => {
    const revoked = await gatewayHarness({ ...gatewayRow, revokedAt: new Date() }, true);
    const token = await mint({ connectionIds: ["conn_g"] });
    const before = seen.length;
    const res = await revoked.app.request("/api/proxy/c/conn_g/items", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      reason: "connection_revoked",
      message: "The person revoked this connection; ask them to reconnect it in the console",
    });
    expect(revoked.events.at(-1)).toMatchObject({
      outcome: "connection_revoked",
      connectionId: "conn_g",
      relay: null,
    });
    expect(seen).toHaveLength(before);
  });
});
