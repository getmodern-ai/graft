import { createProxyApp, type ProxyDeps, type ProxyEvent, type UpstreamFetch } from "@graft/proxy";
import { type CapabilityTokenKeys, createCapabilityTokenVerifier } from "@graft/token";
import type { CredentialVault } from "@graft/vault";
import { type EvlogVariables, evlog, useLogger } from "evlog/hono";
import { Hono } from "hono";

/**
 * The server, as a function of what it is handed — so `app.test.ts` drives the same app `index.ts`
 * serves, with a key pair generated for the test and a fake upstream in place of the network.
 *
 * This file is the host binding for `@graft/proxy` (GRA-1, "the proxy separable from the server by
 * DNS alone"): the proxy package knows only a connection, its scheme, its host set and a token, and
 * everything Graft-shaped is bound here and handed across as functions — the deployment's key pair
 * as a verifier, the connection read, the vault's decrypt, the wide-event sink. Moving the proxy to
 * its own service means a file shaped like this one over there and a DNS change here.
 */

export type ServerDeps = {
  /** The deployment's key pair, or null: the proxy then answers 503 `proxy_unconfigured`. */
  keys: CapabilityTokenKeys | null;
  /** The vault's decrypt half is the one the proxy takes; nothing else on this server decrypts. */
  vault: Pick<CredentialVault, "decrypt">;
  connections: ProxyDeps["connections"];
  /** The break glass from the environment — off unless the deployment says otherwise. */
  followRedirects: boolean;
  /** A test's fake vendor; production takes the proxy's default, undici behind the guarded resolver. */
  upstreamFetch?: UpstreamFetch;
  /** Where the proxy's one event per call goes; by default onto the request's wide event. */
  log?: (event: ProxyEvent) => void;
};

/** Where the proxy answers — the path `GRAFT_PROXY_PUBLIC_URL` defaults to ends in this. */
export const PROXY_MOUNT_PATH = "/api/proxy";

export function createServer(deps: ServerDeps): Hono<EvlogVariables> {
  const app = new Hono<EvlogVariables>();

  // One wide event per request; `useLogger()` below is the handle on it from inside the proxy, so
  // the proxy's event lands on this request's line under `proxy` rather than as a second line.
  app.use(evlog());

  /**
   * The credential-injecting reverse proxy: `ALL /api/proxy/c/:connectionId/*`, the explicit host
   * form beneath it, and `GET /api/proxy/.well-known/jwks.json`. Mounted **first** — above anything
   * a later ticket adds here (a CORS middleware for the console, GRA-26; a session lookup, GRA-19)
   * — for two reasons the order has to keep. The proxy is server-to-server: its callers are sandbox
   * processes presenting a capability token, never a browser with a cookie, so a CORS answer on its
   * responses would be a claim about an origin that does not exist, and Hono's `cors()` answers
   * every `OPTIONS` itself, which would keep a vendor's own `OPTIONS` from ever reaching the vendor.
   * And a session middleware resolves a session per request, a database round trip a vendor call
   * should never pay for, since a context whose session is null is exactly right for it.
   */
  app.route(
    PROXY_MOUNT_PATH,
    createProxyApp({
      ...createCapabilityTokenVerifier(deps.keys),
      connections: deps.connections,
      decryptCredential: (ciphertext, scope) => deps.vault.decrypt(ciphertext, scope),
      log: deps.log ?? ((event) => useLogger().set({ proxy: event })),
      options: { followRedirects: deps.followRedirects },
      ...(deps.upstreamFetch ? { upstreamFetch: deps.upstreamFetch } : {}),
    }),
  );

  app.get("/", (c) => c.text("OK"));

  return app;
}
