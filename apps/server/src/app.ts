import { createMcpHttpApp, type McpDeps } from "@graft/mcp";
import { createProxyApp, type ProxyDeps, type ProxyEvent, type UpstreamFetch } from "@graft/proxy";
import { type CapabilityTokenKeys, createCapabilityTokenVerifier } from "@graft/token";
import type { CredentialVault } from "@graft/vault";
import { type EvlogVariables, evlog, useLogger } from "evlog/hono";
import { Hono } from "hono";

import { type ApiOptions, createApi } from "./api";
import { type ConsoleOptions, createConsoleApp } from "./console";

/**
 * The server, as a function of what it is handed — so `app.test.ts` drives the same app `index.ts`
 * serves, with a key pair generated for the test and a fake upstream in place of the network.
 *
 * This file is the host binding for `@graft/proxy` (GRA-1, "the proxy separable from the server by
 * DNS alone"): the proxy package knows only a connection, its scheme, its host set and a token, and
 * everything Graft-shaped is bound here and handed across as functions — the deployment's key pair
 * as a verifier, the connection read, the vault's decrypt, the wide-event sink. Moving the proxy to
 * its own service means a file shaped like this one over there and a DNS change here.
 *
 * `decryptCredential` below is the **one place** a stored credential becomes plaintext (GRA-1, "The
 * core and its seams"). `@graft/core`'s connection service takes the vault's encrypt half only, so a
 * decrypt anywhere on a person's request path does not compile.
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
  /**
   * The person's half — Better Auth and the JSON API (`api.ts`). Optional so a proxy-only harness,
   * the shape GRA-5's tests drive, needs neither a database nor an auth instance.
   */
  api?: ApiOptions;
  /**
   * The agent's half — the MCP endpoint (`@graft/mcp`, ADR 0003). Optional for the same reason;
   * `index.ts` always binds it.
   */
  mcp?: McpDeps;
  /**
   * The console's build, served same-origin (`console.ts`, GRA-26). Optional so the proxy and API
   * harnesses need no directory; `index.ts` always binds it, to `GRAFT_CONSOLE_DIR`.
   */
  console?: Pick<ConsoleOptions, "dir">;
};

/** Where the proxy answers — the path `GRAFT_PROXY_PUBLIC_URL` defaults to ends in this. */
export const PROXY_MOUNT_PATH = "/api/proxy";

/** Where Better Auth and the JSON API answer: `/api/auth/*`, `/api/agents`, `/api/connections`. */
export const API_MOUNT_PATH = "/api";

/** Where a harness connects: one streamable-HTTP endpoint, the agent's bearer token in `Authorization`. */
export const MCP_MOUNT_PATH = "/mcp";

export function createServer(deps: ServerDeps): Hono<EvlogVariables> {
  const app = new Hono<EvlogVariables>();

  // One wide event per request; `useLogger()` below is the handle on it from inside the proxy, so
  // the proxy's event lands on this request's line under `proxy` rather than as a second line.
  app.use(evlog());

  /**
   * The credential-injecting reverse proxy: `ALL /api/proxy/c/:connectionId/*`, the explicit host
   * form beneath it, and `GET /api/proxy/.well-known/jwks.json`. Mounted **first** — above the API
   * and its CORS middleware and Better Auth — for two reasons the order has to keep. The proxy is
   * server-to-server: its callers are sandbox processes presenting a capability token, never a
   * browser with a cookie, so a CORS answer on its responses would be a claim about an origin that
   * does not exist, and Hono's `cors()` answers every `OPTIONS` itself, which would keep a vendor's
   * own `OPTIONS` from ever reaching the vendor. And the API resolves a session per request, a
   * database round trip a vendor call should never pay for, since a context with no session is
   * exactly right for it.
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

  /**
   * The MCP endpoint, outside `/api` and its CORS: a harness is a server-side client presenting a
   * bearer token, never a browser with a cookie, and the endpoint checks that token on every request
   * before the transport sees it (`@graft/mcp`'s `createMcpHttpApp`).
   */
  if (deps.mcp) {
    app.route(MCP_MOUNT_PATH, createMcpHttpApp(deps.mcp));
  }

  if (deps.api) {
    app.route(API_MOUNT_PATH, createApi(deps.api));
  }

  /**
   * The console last, so every server path above has had its match. With a build present it owns
   * `/` — its `index.html` is a 200, which is what a health check reads — and every other path a
   * browser navigates to. Without one, `/` stays the plain `OK` and the console's paths answer the
   * JSON 404 `console.ts` describes, so a deployment with no console is a smaller server, not a
   * broken one.
   */
  const console = deps.console
    ? createConsoleApp({ ...deps.console, exclude: [API_MOUNT_PATH, MCP_MOUNT_PATH] })
    : null;
  if (console?.built) {
    app.route("/", console.app);
  } else {
    app.get("/", (c) => c.text("OK"));
    if (console) app.route("/", console.app);
  }

  return app;
}
