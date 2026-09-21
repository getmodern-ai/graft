import type { AgentDeps, McpOAuthDeps, SessionLike } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { McpDeps } from "@graft/mcp";
import type { RateLimitBucket, RateLimitCheck, RateLimiter } from "@graft/ratelimit";
import { createMemoryRateLimiter, UNLIMITED } from "@graft/ratelimit";
import { initLogger } from "evlog";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ApiOptions } from "./api";
import { createServer, type ServerDeps } from "./app";
import {
  addressKey,
  apiDoorKey,
  clientAddressOf,
  identifiedKey,
  mcpDoorKey,
  oauthRefusalBody,
  proxyDoorKey,
  proxyRefusalBody,
  rateLimit,
  signInDoorKey,
} from "./rate-limit";

/**
 * The server's half of the rate-limit seam (GRA-149): the middleware through `app.request`, each
 * door's key as a pure function, and one pass per door through the whole server proving the bucket
 * and the key it counts on. The backing's own rule is `packages/ratelimit`'s suite; nothing here
 * needs a database or a clock.
 */

initLogger({ silent: true });

/** A limiter that records what it was asked and answers as the test told it to. */
function recorder(verdict: "allow" | { retryAfterSeconds: number } = "allow") {
  const checks: RateLimitCheck[] = [];
  const limiter: RateLimiter = {
    name: "recorder",
    check: async (input) => {
      checks.push(input);
      return verdict === "allow" ? { allowed: true } : { allowed: false, ...verdict };
    },
  };
  return { checks, limiter };
}

const ADDRESS = { "x-forwarded-for": "203.0.113.7" };

describe("the rateLimit middleware", () => {
  const appWith = (limiter: RateLimiter, handler = vi.fn(() => new Response("handled"))) => {
    const app = new Hono();
    app.use(
      "*",
      rateLimit(limiter, "api", () => identifiedKey("person", "person_1")),
    );
    app.all("*", () => handler());
    return { app, handler };
  };

  it("lets an allowed request through untouched", async () => {
    const { limiter, checks } = recorder();
    const { app, handler } = appWith(limiter);
    const res = await app.request("/anything", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("handled");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
    expect(checks).toEqual([{ bucket: "api", key: "person:person_1", now: expect.any(Date) }]);
  });

  it("answers 429 with Retry-After on a refusal, and never reaches the handler", async () => {
    const { limiter } = recorder({ retryAfterSeconds: 37 });
    const { app, handler } = appWith(limiter);
    const res = await app.request("/anything", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("37");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "TOO_MANY_REQUESTS",
      message: "Too many requests. Try again in 37 second(s).",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers the door's own body shape when the door names one", async () => {
    const { limiter } = recorder({ retryAfterSeconds: 2 });
    const app = new Hono();
    app.use(
      "*",
      rateLimit(limiter, "proxy", () => identifiedKey("connection", "conn_1"), {
        body: proxyRefusalBody,
      }),
    );
    app.all("*", (c) => c.text("handled"));
    expect(await (await app.request("/x")).json()).toEqual({
      error: "too_many_requests",
      reason: "rate_limited",
      message: "Too many requests. Try again in 2 second(s).",
    });
  });

  it("does not ask the limiter, or mint a key, for a request the door does not limit", async () => {
    const { limiter, checks } = recorder({ retryAfterSeconds: 9 });
    const keyOf = vi.fn(() => null);
    const app = new Hono();
    app.use("*", rateLimit(limiter, "api", keyOf));
    app.all("*", (c) => c.text("handled"));
    expect((await app.request("/x")).status).toBe(200);
    expect(keyOf).toHaveBeenCalledOnce();
    expect(checks).toEqual([]);
  });

  it("does no work at all under UNLIMITED, which is the default in both forms", async () => {
    const keyOf = vi.fn(() => identifiedKey("person", "person_1"));
    const app = new Hono();
    app.use("*", rateLimit(UNLIMITED, "api", keyOf));
    app.all("*", (c) => c.text("handled"));
    expect((await app.request("/x")).status).toBe(200);
    expect(keyOf).not.toHaveBeenCalled();
  });

  it("fails open when the backing throws: a store's trouble does not close a door", async () => {
    const limiter: RateLimiter = {
      name: "broken",
      check: async () => {
        throw new Error("the store is down");
      },
    };
    const app = new Hono();
    app.use(
      "*",
      rateLimit(limiter, "api", () => identifiedKey("person", "person_1")),
    );
    app.all("*", (c) => c.text("handled"));
    expect((await app.request("/x")).status).toBe(200);
  });
});

describe("the keys a door counts on", () => {
  it("logs an id as it is, since the wide event already names the person or the agent", () => {
    expect(identifiedKey("person", "person_1")).toEqual({
      key: "person:person_1",
      logged: "person:person_1",
    });
  });

  it("counts an address but never logs one", () => {
    const key = addressKey("203.0.113.7");
    expect(key.key).toBe("addr:203.0.113.7");
    expect(key.logged).not.toContain("203.0.113.7");
    expect(key.logged).toMatch(/^addr:[0-9a-f]{12}$/);
    // Stable within a deployment, so one caller is one line's worth of key across many lines.
    expect(addressKey("203.0.113.7").logged).toBe(key.logged);
    expect(addressKey("203.0.113.8").logged).not.toBe(key.logged);
  });
});

describe("clientAddressOf", () => {
  const context = (headers: Record<string, string>, remoteAddress?: string) => {
    const app = new Hono();
    let seen: string | null | undefined;
    app.all("*", (c) => {
      seen = clientAddressOf(c, hops);
      return c.text("ok");
    });
    let hops = 0;
    return {
      at: async (trustedProxyHops: number) => {
        hops = trustedProxyHops;
        await app.request(
          "/",
          { headers },
          remoteAddress === undefined ? undefined : { incoming: { socket: { remoteAddress } } },
        );
        return seen;
      },
    };
  };

  it("takes the socket's peer address and never the header, unless the operator said how many hops", async () => {
    const c = context({ "x-forwarded-for": "198.51.100.9" }, "203.0.113.7");
    expect(await c.at(0)).toBe("203.0.113.7");
  });

  it("takes the nth entry from the right of X-Forwarded-For when the operator named n hops", async () => {
    const c = context({ "x-forwarded-for": "198.51.100.9, 10.0.0.1, 10.0.0.2" }, "10.0.0.2");
    expect(await c.at(1)).toBe("10.0.0.2");
    expect(await c.at(2)).toBe("10.0.0.1");
    expect(await c.at(3)).toBe("198.51.100.9");
  });

  it("falls back to the socket when the header is shorter than the hops described, or absent", async () => {
    const short = context({ "x-forwarded-for": "198.51.100.9" }, "203.0.113.7");
    expect(await short.at(3)).toBe("203.0.113.7");
    const none = context({}, "203.0.113.7");
    expect(await none.at(2)).toBe("203.0.113.7");
  });

  it("answers null when there is no socket to ask, and a door with no key does not limit", async () => {
    const c = context({});
    expect(await c.at(0)).toBeNull();
  });
});

describe("each door's key", () => {
  /** A context for a pure key function, driven through a one-route app. */
  async function keyFor(
    door: (c: Parameters<ReturnType<typeof proxyDoorKey>>[0]) => unknown,
    path: string,
    init: RequestInit = {},
  ) {
    const app = new Hono();
    let seen: unknown;
    app.all("*", async (c) => {
      seen = await door(c);
      return c.text("ok");
    });
    await app.request(path, init);
    return seen;
  }

  const limiting = { limiter: UNLIMITED, trustedProxyHops: 1 };

  it("sign_in: every POST under /api/auth but the sign-out, keyed by address", async () => {
    const door = signInDoorKey(limiting);
    expect(
      await keyFor(door, "/api/auth/sign-in/email", { method: "POST", headers: ADDRESS }),
    ).toEqual(addressKey("203.0.113.7"));
    expect(
      await keyFor(door, "/api/auth/request-password-reset", { method: "POST", headers: ADDRESS }),
    ).toEqual(addressKey("203.0.113.7"));
    // The console holds the session read open; it is a GET and nobody's allowance.
    expect(await keyFor(door, "/api/auth/get-session", { headers: ADDRESS })).toBeNull();
    // A person ending their own session is not what a limit is for.
    expect(
      await keyFor(door, "/api/auth/sign-out", { method: "POST", headers: ADDRESS }),
    ).toBeNull();
  });

  it("mcp: the caller's address, and the same key whatever bearer is presented", async () => {
    const door = mcpDoorKey(limiting);
    const at = (authorization?: string) =>
      keyFor(door, "/mcp", {
        method: "POST",
        headers: authorization ? { ...ADDRESS, authorization } : ADDRESS,
      });
    expect(await at()).toEqual(addressKey("203.0.113.7"));
    // A key derived from the token would be a key the caller picks: two invented bearers must not
    // be two allowances, since each still costs `requireAgent` a read (GRA-149, Greptile on #116).
    expect(await at("Bearer grft_one")).toEqual(addressKey("203.0.113.7"));
    expect(await at("Bearer grfta_two")).toEqual(addressKey("203.0.113.7"));
  });

  it("proxy: the connection the path names, and nothing for the JWKS", async () => {
    const door = proxyDoorKey();
    expect(await keyFor(door, "/api/proxy/c/conn_1/items?q=1")).toEqual(
      identifiedKey("connection", "conn_1"),
    );
    expect(await keyFor(door, "/api/proxy/c/conn_1")).toEqual(
      identifiedKey("connection", "conn_1"),
    );
    expect(await keyFor(door, "/api/proxy/.well-known/jwks.json")).toBeNull();
  });

  it("proxy: a segment that does not percent-decode is the key as it was spelled, never a throw", async () => {
    const door = proxyDoorKey();
    expect(await keyFor(door, "/api/proxy/c/%E0%A4%A/items")).toEqual(
      identifiedKey("connection", "%E0%A4%A"),
    );
    expect(await keyFor(door, "/api/proxy/c/conn%5F1")).toEqual(
      identifiedKey("connection", "conn_1"),
    );
  });

  it("api: a mutation with a session, keyed by the person; nothing for a read, /auth or no session", async () => {
    const session = async (): Promise<SessionLike> => ({ user: { id: "person_1" } });
    const door = apiDoorKey(session);
    expect(await keyFor(door, "/api/agents", { method: "POST" })).toEqual(
      identifiedKey("person", "person_1"),
    );
    expect(await keyFor(door, "/api/agents")).toBeNull();
    expect(await keyFor(door, "/api/auth/sign-in/email", { method: "POST" })).toBeNull();
    const none = apiDoorKey(async () => null);
    expect(await keyFor(none, "/api/agents", { method: "POST" })).toBeNull();
    const broken = apiDoorKey(async () => {
      throw new Error("no database");
    });
    expect(await keyFor(broken, "/api/agents", { method: "POST" })).toBeNull();
  });
});

/**
 * One pass per door through the server `index.ts` serves, so the bucket and the key a door counts
 * on are pinned where they are mounted rather than only where they are written.
 */
describe("the doors the server mounts", () => {
  function server(limiter: RateLimiter, overrides: Partial<ServerDeps> = {}) {
    return createServer({
      keys: null,
      vault: { decrypt: async () => ({}) },
      connections: { get: async () => null },
      followRedirects: false,
      rateLimit: { limiter, trustedProxyHops: 1 },
      ...overrides,
    });
  }

  const api: ApiOptions = {
    auth: {
      handler: async () => new Response("auth", { status: 200 }),
      getSession: async () => ({ user: { id: "person_1" } }),
    },
    // No route reached in this suite touches a repository: a refused request stops in the
    // middleware, and the one allowed request is Better Auth's own handler above.
    deps: {} as ApiOptions["deps"],
    corsOrigins: [],
    handoff: { consoleUrl: "http://console.example", secret: "s".repeat(32) },
  };

  const mcpOAuth = {
    db: {} as DbOrTx,
    deps: {} as McpOAuthDeps,
    agent: {} as AgentDeps,
    authUrl: "http://localhost:3000",
    consoleUrl: "http://localhost:3001",
  };

  const door = async (
    path: string,
    init: RequestInit,
    overrides: Partial<ServerDeps> = {},
  ): Promise<{
    bucket: RateLimitBucket;
    key: string;
    status: number;
    retryAfter: string | null;
  }> => {
    const { limiter, checks } = recorder({ retryAfterSeconds: 5 });
    const res = await server(limiter, overrides).request(path, init);
    const check = checks[0];
    if (!check) throw new Error(`no rate-limit check was made for ${path}`);
    return {
      bucket: check.bucket,
      key: check.key,
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
    };
  };

  it("counts /api/proxy per connection and refuses in the proxy's shape", async () => {
    const { limiter, checks } = recorder({ retryAfterSeconds: 5 });
    const res = await server(limiter).request("/api/proxy/c/conn_1/items", { headers: ADDRESS });
    expect(checks[0]).toMatchObject({ bucket: "proxy", key: "connection:conn_1" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual(
      proxyRefusalBody("Too many requests. Try again in 5 second(s)."),
    );
  });

  /**
   * A malformed percent escape in the connection id is the proxy's to refuse, and its refusal is
   * what the caller must see: the key is taken from the segment as it was spelled rather than
   * from a `decodeURIComponent` that would throw (Greptile on #116).
   */
  it("hands a connection id that does not decode to the proxy, which refuses it as it always did", async () => {
    const { limiter, checks } = recorder();
    const res = await server(limiter).request("/api/proxy/c/%E0%A4%A/items", { headers: ADDRESS });
    expect(checks[0]).toMatchObject({ bucket: "proxy", key: "connection:%E0%A4%A" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "bad_connection_id" });
  });

  it("counts /mcp per address, whatever bearer is presented", async () => {
    expect(
      await door("/mcp", {
        method: "POST",
        headers: { ...ADDRESS, authorization: "Bearer grft_abc" },
      }),
    ).toEqual({
      bucket: "mcp",
      key: "addr:203.0.113.7",
      status: 429,
      retryAfter: "5",
    });
  });

  /**
   * The bypass the address key exists to close (Greptile on #116): a caller inventing a bearer per
   * request would get an allowance per request if the key came from the token, and each of those
   * requests would still reach `requireAgent`'s database read, which is what the door rations.
   */
  it("stops a caller rotating invented bearers, and the refused one never reaches requireAgent", async () => {
    const lookups = { count: 0 };
    const mcp = {
      db: {} as DbOrTx,
      agent: {
        findAgentByTokenHash: async () => {
          lookups.count += 1;
          return null;
        },
        findAgentByMcpAccessTokenHash: async () => {
          lookups.count += 1;
          return null;
        },
        now: () => new Date(),
      },
    } as unknown as McpDeps;
    const limiter = createMemoryRateLimiter(
      {
        sign_in: null,
        oauth_register: null,
        oauth_token: null,
        mcp: { limit: 2, windowSeconds: 60 },
        proxy: null,
        api: null,
      },
      {},
    );
    const app = server(limiter, { mcp });
    const knock = (n: number) =>
      app.request("/mcp", {
        method: "POST",
        headers: { ...ADDRESS, authorization: `Bearer grft_invented_${n}` },
      });

    expect((await knock(1)).status).toBe(401);
    expect((await knock(2)).status).toBe(401);
    expect(lookups.count).toBe(2);

    const refused = await knock(3);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(lookups.count).toBe(2);
  });

  it("counts /mcp/oauth/register and /mcp/oauth/token per address, and refuses in the protocol's shape", async () => {
    expect(
      await door("/mcp/oauth/register", { method: "POST", headers: ADDRESS }, { mcpOAuth }),
    ).toEqual({
      bucket: "oauth_register",
      key: "addr:203.0.113.7",
      status: 429,
      retryAfter: "5",
    });
    expect(
      await door("/mcp/oauth/token", { method: "POST", headers: ADDRESS }, { mcpOAuth }),
    ).toMatchObject({ bucket: "oauth_token", key: "addr:203.0.113.7" });

    const { limiter } = recorder({ retryAfterSeconds: 5 });
    const res = await server(limiter, { mcpOAuth }).request("/mcp/oauth/register", {
      method: "POST",
      headers: ADDRESS,
    });
    expect(await res.json()).toEqual(
      oauthRefusalBody("Too many requests. Try again in 5 second(s)."),
    );
  });

  it("counts a Better Auth write per address, and lets an allowed one reach Better Auth", async () => {
    expect(
      await door("/api/auth/sign-in/email", { method: "POST", headers: ADDRESS }, { api }),
    ).toEqual({
      bucket: "sign_in",
      key: "addr:203.0.113.7",
      status: 429,
      retryAfter: "5",
    });

    const { limiter, checks } = recorder();
    const res = await server(limiter, { api }).request("/api/auth/sign-in/email", {
      method: "POST",
      headers: ADDRESS,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("auth");
    expect(checks.map((check) => check.bucket)).toEqual(["sign_in"]);
  });

  it("counts an API mutation per person, and leaves an API read uncounted", async () => {
    expect(await door("/api/agents", { method: "POST", headers: ADDRESS }, { api })).toEqual({
      bucket: "api",
      key: "person:person_1",
      status: 429,
      retryAfter: "5",
    });

    const { limiter, checks } = recorder({ retryAfterSeconds: 5 });
    const res = await server(limiter, { api }).request("/api/health");
    expect(res.status).toBe(200);
    expect(checks).toEqual([]);
  });
});
