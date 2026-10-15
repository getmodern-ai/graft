import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import {
  createGuardedFetch,
  createUpstreamFetch,
  guardedLookup,
  isPrivateAddressFailure,
  isTimeoutFailure,
  PrivateAddressError,
  type ResolveAll,
} from "./upstream";

/**
 * The resolver the socket is opened through — "refused at resolution" (GRA-1, "The proxy and the
 * capability token"), tested against a scripted DNS so no name is looked up.
 */

function resolver(answers: Record<string, LookupAddress[] | Error>): ResolveAll {
  return (hostname, callback) => {
    const answer = answers[hostname];
    if (answer instanceof Error) return callback(answer, []);
    callback(null, answer ?? []);
  };
}

function lookup(resolve: ResolveAll, hostname: string, options: { all?: boolean } = {}) {
  return new Promise<unknown[]>((done) => {
    guardedLookup(resolve)(hostname, options, (...args) => done(args));
  });
}

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const MIXED = [
  { address: "93.184.216.34", family: 4 },
  { address: "169.254.169.254", family: 4 },
];

describe("guardedLookup", () => {
  it("hands a public address through, in both callback shapes", async () => {
    const resolve = resolver({ "api.vendor.example": PUBLIC });

    expect(await lookup(resolve, "api.vendor.example")).toEqual([null, "93.184.216.34", 4]);
    expect(await lookup(resolve, "api.vendor.example", { all: true })).toEqual([null, PUBLIC]);
  });

  it("refuses a name that resolves to a private address", async () => {
    const [error] = await lookup(
      resolver({ "evil.example": [{ address: "10.0.0.1", family: 4 }] }),
      "evil.example",
    );

    expect(error).toBeInstanceOf(PrivateAddressError);
    expect((error as PrivateAddressError).address).toBe("10.0.0.1");
  });

  /** One private answer among public ones is still a route to the metadata service. */
  it("refuses the whole lookup when any answer is private", async () => {
    const [error] = await lookup(resolver({ "mixed.example": MIXED }), "mixed.example");

    expect(error).toBeInstanceOf(PrivateAddressError);
  });

  it("refuses the IPv6 private and mapped forms", async () => {
    const [ula] = await lookup(resolver({ a: [{ address: "fd00::1", family: 6 }] }), "a");
    const [mapped] = await lookup(
      resolver({ b: [{ address: "::ffff:10.0.0.1", family: 6 }] }),
      "b",
    );
    const [ok] = await lookup(
      resolver({ c: [{ address: "2606:4700:4700::1111", family: 6 }] }),
      "c",
    );

    expect(ula).toBeInstanceOf(PrivateAddressError);
    expect(mapped).toBeInstanceOf(PrivateAddressError);
    expect(ok).toBeNull();
  });

  /**
   * The answers are addresses, and the guard asks the address question of them (`isPublicAddress`,
   * GRA-176): a resolver that answered with a name — which `dns.lookup` never does, but the seam
   * admits — is refused rather than judged as a public hostname would be.
   */
  it("refuses an answer that is not an address at all", async () => {
    for (const answer of ["api.vendor.example", "localhost", "", "999.1.1.1"]) {
      const [error] = await lookup(
        resolver({ "evil.example": [{ address: answer, family: 4 }] }),
        "evil.example",
      );
      expect(error, answer).toBeInstanceOf(PrivateAddressError);
      expect((error as PrivateAddressError).address).toBe(answer);
    }
  });

  /** The operator's configured upstream may resolve privately — a company gateway (ADR 0019, GRA-58) — and nothing else may. */
  it("lifts the guard for a named host alone, compared case-insensitively", async () => {
    const resolve = resolver({
      "gateway.corp.internal": [{ address: "10.0.0.7", family: 4 }],
      "evil.example": [{ address: "10.0.0.1", family: 4 }],
    });
    const lookup = (hostname: string) =>
      new Promise<unknown[]>((done) => {
        guardedLookup(resolve, ["Gateway.Corp.Internal"])(hostname, {}, (...args) => done(args));
      });

    expect(await lookup("gateway.corp.internal")).toEqual([null, "10.0.0.7", 4]);
    const [error] = await lookup("evil.example");
    expect(error).toBeInstanceOf(PrivateAddressError);
  });

  it("passes a resolver error through and treats no answer as a refusal", async () => {
    const failure = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    const [error] = await lookup(resolver({ gone: failure }), "gone");
    const [empty] = await lookup(resolver({}), "nothing.example");

    expect(error).toBe(failure);
    expect(empty).toBeInstanceOf(PrivateAddressError);
  });
});

describe("createGuardedFetch", () => {
  it("refuses a name that resolves to a private address, at the socket", async () => {
    const guarded = createGuardedFetch({
      resolveAll: resolver({ "gateway.example": [{ address: "127.0.0.1", family: 4 }] }),
    });
    const error = await guarded("https://gateway.example/v1/chat", {
      method: "POST",
      body: "{}",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPrivateAddressFailure(error)).toBe(true);
  });

  it("refuses a private literal, any spelling the URL parser canonicalises, without a lookup", async () => {
    let looked = 0;
    const guarded = createGuardedFetch({
      resolveAll: (_hostname, callback) => {
        looked += 1;
        callback(null, PUBLIC);
      },
    });
    for (const url of [
      "http://169.254.169.254/latest",
      "http://2852039166/",
      "http://[::ffff:10.0.0.1]/",
      "http://localhost:3000/v1",
    ]) {
      const error = await guarded(url).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PrivateAddressError);
    }
    expect(looked).toBe(0);
  });
});

describe("createGuardedFetch's request and response", () => {
  it("carries a JSON POST to a public host and hands back the platform's Response", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    let seen: { body: unknown; auth: unknown } | null = null;
    mock
      .get("https://gateway.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        200,
        (request) => {
          const headers = request.headers as Record<string, string>;
          const text = Buffer.from(request.body as Uint8Array).toString("utf8");
          seen = { body: JSON.parse(text), auth: headers.authorization };
          return { id: "chat_1" };
        },
        { headers: { "content-type": "application/json" } },
      );
    const guarded = createGuardedFetch({ dispatcher: mock });

    const response = await guarded("https://gateway.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: "chat_1" });
    expect(seen).toEqual({ body: { model: "m" }, auth: "Bearer k" });
  });

  it("returns a redirect to a private address as it came, with no second request", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get("https://gateway.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(302, "", { headers: { location: "http://169.254.169.254/latest/meta-data" } });
    const guarded = createGuardedFetch({ dispatcher: mock });

    const response = await guarded("https://gateway.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data");
    // Net connect is off and nothing intercepts the metadata host: a followed redirect would throw.
    mock.assertNoPendingInterceptors();
  });
});

describe("failure classification through a cause chain", () => {
  it("finds the resolver's refusal where undici wraps it", () => {
    const wrapped = new TypeError("fetch failed", {
      cause: new PrivateAddressError("h", "10.0.0.1"),
    });
    expect(isPrivateAddressFailure(wrapped)).toBe(true);
    expect(isPrivateAddressFailure(new TypeError("fetch failed"))).toBe(false);
    expect(isPrivateAddressFailure("nope")).toBe(false);
  });

  it("finds the timeout abort", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isTimeoutFailure(timeout)).toBe(true);
    expect(isTimeoutFailure(new Error("x", { cause: timeout }))).toBe(true);
    expect(isTimeoutFailure(new Error("ECONNRESET"))).toBe(false);
  });
});

/**
 * A vendor whose handshake answers after Node's 250 ms happy-eyeballs attempt timer (GRA-339:
 * `geocoding-api.open-meteo.com` from ap-southeast-2, one IPv4 address ~330 ms away, its IPv6
 * address unroutable). A local server answers its handshake at once, so the late answer is made
 * the way the event loop sees it: the resolver hands the addresses back from a check-phase
 * callback and then holds the loop past the attempt timer, so when the loop next runs its timers
 * phase the timer has expired with the handshake's completion still unread. Node abandons the
 * first address, the second (`::1`, where nothing listens on that port, or no IPv6 at all) fails
 * at once, and the connect is `AggregateError [ETIMEDOUT]` — the production failure exactly.
 */
describe("a handshake slower than the happy-eyeballs default", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  async function slowUpstream(): Promise<{ url: string; resolveAll: ResolveAll }> {
    server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const resolveAll: ResolveAll = (_hostname, callback) => {
      setImmediate(() => {
        callback(null, [
          { address: "127.0.0.1", family: 4 },
          { address: "::1", family: 6 },
        ]);
        const until = Date.now() + 400;
        while (Date.now() < until) {
          // Hold the loop: the handshake lands now, but is read only after the timers phase.
        }
      });
    };
    return { url: `http://slow.vendor.test:${port}/`, resolveAll };
  }

  const get = (url: string) => ({ url, method: "GET", headers: new Headers(), body: null });
  const signal = () => AbortSignal.timeout(5_000);

  it("fails as production did under Node's 250 ms attempt timeout", async () => {
    const { url, resolveAll } = await slowUpstream();
    const fetch = createUpstreamFetch({
      resolveAll,
      unguardedHosts: ["slow.vendor.test"],
      connectAttemptTimeoutMs: 250,
    });

    const failure = await fetch(get(url), { signal: signal() }).catch((error: unknown) => error);

    expect(causeCodes(failure)).toContain("ETIMEDOUT");
  });

  it("connects under the proxy's attempt timeout", async () => {
    const { url, resolveAll } = await slowUpstream();
    const fetch = createUpstreamFetch({ resolveAll, unguardedHosts: ["slow.vendor.test"] });

    const response = await fetch(get(url), { signal: signal() });

    expect(response.status).toBe(200);
    expect(await new Response(response.body).text()).toBe("ok");
  });
});

/** Every `code` down a `cause` chain and inside an `AggregateError`'s `errors`. */
function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  const pending = [error];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!(next instanceof Error)) continue;
    const code = (next as NodeJS.ErrnoException).code;
    if (code) codes.push(code);
    pending.push(next.cause);
    if (next instanceof AggregateError) pending.push(...next.errors);
  }
  return codes;
}
