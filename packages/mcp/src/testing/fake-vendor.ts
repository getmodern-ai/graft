import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  createProxyApp,
  type ProxyConnection,
  type ProxyEvent,
  type UpstreamRequest,
} from "@graft/proxy";
import type { AuthScheme } from "@graft/proxy/types";
import {
  type CapabilityTokenKeys,
  createCapabilityTokenVerifier,
  importCapabilityTokenKeys,
} from "@graft/token";
import { type CredentialVault, createCredentialVault, createLocalKeyring } from "@graft/vault";
import { serve } from "@hono/node-server";

/**
 * A vendor behind the real proxy, on a loopback port — what a run in the fake sandbox reaches.
 *
 * The runner is a child process making real HTTP calls to `GRAFT_PROXY_URL`, so the proxy has to be
 * listening; the vendor behind it does not — `createProxyApp`'s `upstreamFetch` is injected, records
 * every request that would have left for the vendor and answers from a script, so no name is
 * resolved and nothing leaves the machine. The connection is seeded with a real ciphertext from the
 * real vault, which is how the suite can assert that the vendor saw the decrypted credential and
 * never the token (GRA-19's acceptance criterion).
 *
 * A suite that creates connections *during* the run — GRA-28's handoff, where the person's submit
 * makes the row — hands `resolve` a read of its own store and encrypts with the returned `vault`,
 * so the proxy decrypts what the connection service wrote with the same keyring.
 */

const VAULT_SECRET = "graft-mcp-test-vault-secret-that-is-long-enough";

/** An Ed25519 pair as `@graft/token` imports it — Node's own generator, PEM out. */
export async function generateTestKeys(): Promise<CapabilityTokenKeys> {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return importCapabilityTokenKeys({
    privateKeyPem: pair.privateKey,
    publicKeyPem: pair.publicKey,
  });
}

export type FakeVendorConnection = {
  id: string;
  personId: string;
  authScheme?: AuthScheme;
  primaryHost: string;
  hosts?: readonly string[];
  schemeConfig?: Record<string, string>;
  /** The scheme's credential fields, in the clear — encrypted into the row here and then forgotten. */
  credential: Record<string, string>;
};

export type FakeVendor = {
  /** The proxy's base URL — what a sandbox is handed as `GRAFT_PROXY_URL`. */
  url: string;
  /** The vault the seeded ciphertexts were made with; a suite's connection deps take its `encrypt`. */
  vault: CredentialVault;
  /** Every request that reached the vendor, in order. */
  requests: UpstreamRequest[];
  /** The proxy's one wide event per call. */
  events: ProxyEvent[];
  close(): Promise<void>;
};

export async function startFakeVendor(args: {
  keys: CapabilityTokenKeys;
  connections: readonly FakeVendorConnection[];
  /** What the vendor answers; the default is a small JSON body. */
  respond?: (request: UpstreamRequest) => Response | Promise<Response>;
  /** A connection not among the seeds — read from a suite's store, for rows made during the run. */
  resolve?: (id: string) => Promise<ProxyConnection | null>;
}): Promise<FakeVendor> {
  const vault = createCredentialVault(createLocalKeyring(VAULT_SECRET));
  const rows = new Map<string, ProxyConnection>();
  for (const seed of args.connections) {
    const primary = new URL(seed.primaryHost);
    rows.set(seed.id, {
      id: seed.id,
      personId: seed.personId,
      authScheme: seed.authScheme ?? "api_key_header",
      primaryHost: seed.primaryHost,
      hosts: [...new Set([primary.hostname, ...(seed.hosts ?? [])])],
      schemeConfig: seed.schemeConfig ?? { headerName: "x-demo-key" },
      credentialCiphertext: await vault.encrypt(seed.credential, {
        personId: seed.personId,
        connectionId: seed.id,
      }),
    });
  }

  const requests: UpstreamRequest[] = [];
  const events: ProxyEvent[] = [];
  const respond =
    args.respond ??
    (() =>
      Response.json({ items: [{ id: "itm_1", name: "Widget" }], vendor: "demo" }, { status: 200 }));

  const app = createProxyApp({
    ...createCapabilityTokenVerifier(args.keys),
    connections: { get: async (id) => rows.get(id) ?? (await args.resolve?.(id)) ?? null },
    decryptCredential: (ciphertext, scope) => vault.decrypt(ciphertext, scope),
    upstreamFetch: async (request) => {
      requests.push(request);
      return respond(request);
    },
    log: (event) => events.push(event),
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
      resolve(listening),
    );
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    vault,
    requests,
    events,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
