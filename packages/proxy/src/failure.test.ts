import { describe, expect, it } from "vitest";

import {
  deriveRefusal,
  describeFailure,
  guardHostDeps,
  HostDependencyError,
  refusalBody,
  refuse,
  refuseIncomplete,
  refuseResponseTimeout,
  refuseResponseTooLarge,
  refuseResponseUnreadable,
  refuseUpstreamFailure,
} from "./failure";
import { DerivedCredentialError, MissingSchemeParameterError } from "./schemes";
import type { ProxyDeps } from "./types";
import { PrivateAddressError } from "./upstream";

/**
 * Refusal construction on its own. `app.test.ts` proves each refusal through the proxy — status,
 * body and wide event; this suite pins the translations `forward` delegates: how an error becomes
 * a word, and what the event learns from it.
 */

/**
 * An error whose `name` is what the classifiers read — `TimeoutError` is how an
 * `AbortSignal.timeout` abort arrives.
 */
function named(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("refuse and refusalBody", () => {
  it("builds the in-flight shape with whatever detail the rung learned", () => {
    expect(refuse(404, "connection_unknown", "No connection has that id")).toEqual({
      kind: "refused",
      status: 404,
      reason: "connection_unknown",
      message: "No connection has that id",
    });
    expect(
      refuse(502, "upstream_unreachable", "m", { requestBytes: 3, upstreamStatus: 999 }),
    ).toMatchObject({
      requestBytes: 3,
      upstreamStatus: 999,
    });
  });

  it("names the status beside the reason, and says `error` for a status it has no word for", () => {
    expect(refusalBody(401, "token_missing", "m")).toEqual({
      error: "unauthorized",
      reason: "token_missing",
      message: "m",
    });
    expect(refusalBody(409, "credential_incomplete", "m").error).toBe("conflict");
    expect(refusalBody(403, "host_not_in_set", "m").error).toBe("forbidden");
    expect(refusalBody(418, "proxy_error", "m").error).toBe("error");
  });
});

describe("describeFailure", () => {
  it("is null when the refusal carried no error", () => {
    expect(describeFailure(undefined)).toBeNull();
  });

  it("flattens the cause chain to one line, names and messages only", () => {
    const inner = named("ECONNREFUSED", "connect refused");
    const outer = new Error("fetch failed", { cause: inner });
    expect(describeFailure(outer)).toBe("Error: fetch failed <- ECONNREFUSED: connect refused");
  });

  it("describes a thrown non-Error as its text", () => {
    expect(describeFailure("boom")).toBe("boom");
  });
});

/**
 * The host boundary. `app.test.ts` proves it through the proxy — a vault and a store each throw a
 * message holding a secret and the event carries none of it; this suite pins the two pieces: what
 * a `HostDependencyError` is made of, and that `guardHostDeps` puts one in front of every function
 * the host binds and nothing else.
 */
describe("HostDependencyError and guardHostDeps", () => {
  const SECRET = "sk_live_should_never_be_logged";
  const SCOPE = { personId: "person_1", connectionId: "conn_1" };

  function deps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
    return {
      verifyToken: async () => ({ ok: false, reason: "invalid" }),
      jwks: async () => null,
      connections: { get: async () => null },
      decryptCredential: async () => ({ apiKey: "k" }),
      log: () => undefined,
      ...overrides,
    };
  }

  const thrower = (error: unknown) => async () => {
    throw error;
  };

  it("records the dependency and the class names down the chain, and no message or cause", () => {
    const thrown = new Error(`vault refused ${SECRET}`, {
      cause: named("InvalidCiphertextException", `kms said ${SECRET}`),
    });
    const error = new HostDependencyError("decryptCredential", thrown);

    expect(error.name).toBe("HostDependencyError");
    expect(error.dependency).toBe("decryptCredential");
    expect(error.message).toBe("decryptCredential threw Error <- InvalidCiphertextException");
    expect(error.cause).toBeUndefined();
    expect(describeFailure(error)).toBe(
      "HostDependencyError: decryptCredential threw Error <- InvalidCiphertextException",
    );
    expect(describeFailure(error)).not.toContain(SECRET);
  });

  it("names a thrown non-Error by its type, spells nothing, and ends a chain past the cap in ...", () => {
    expect(new HostDependencyError("connections.get", SECRET).message).toBe(
      "connections.get threw string",
    );
    expect(new HostDependencyError("jwks", undefined).message).toBe("jwks threw undefined");
    let deep: Error = new Error("0");
    for (let i = 1; i < 8; i++) deep = new Error(String(i), { cause: deep });
    expect(new HostDependencyError("verifyToken", deep).message).toBe(
      "verifyToken threw Error <- Error <- Error <- Error <- Error <- ...",
    );
  });

  it("wraps what every host-bound function throws, naming the function", async () => {
    const guarded = guardHostDeps(
      deps({
        verifyToken: thrower(new Error(SECRET)),
        jwks: thrower(new Error(SECRET)),
        connections: { get: thrower(new TypeError(SECRET)) },
        decryptCredential: thrower(new Error(SECRET)),
      }),
    );
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) => error,
      );

    const failures = await Promise.all([
      settle(guarded.verifyToken("t")),
      settle(guarded.jwks()),
      settle(guarded.connections.get("conn_1")),
      settle(guarded.decryptCredential(new Uint8Array(), SCOPE)),
    ]);

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(HostDependencyError);
      expect(describeFailure(failure)).not.toContain(SECRET);
    }
    expect(failures.map((failure) => (failure as HostDependencyError).message)).toEqual([
      "verifyToken threw Error",
      "jwks threw Error",
      "connections.get threw TypeError",
      "decryptCredential threw Error",
    ]);
  });

  it("passes through what a host-bound function answers, with its arguments", async () => {
    const seen: unknown[] = [];
    const guarded = guardHostDeps(
      deps({
        verifyToken: async (token) => {
          seen.push(token);
          return { ok: false, reason: "expired" };
        },
        decryptCredential: async (ciphertext, scope) => {
          seen.push(ciphertext, scope);
          return { apiKey: "k" };
        },
      }),
    );

    expect(await guarded.verifyToken("t")).toEqual({ ok: false, reason: "expired" });
    expect(await guarded.jwks()).toBeNull();
    expect(await guarded.connections.get("conn_1")).toBeNull();
    const ciphertext = new Uint8Array([1]);
    expect(await guarded.decryptCredential(ciphertext, SCOPE)).toEqual({ apiKey: "k" });
    expect(seen).toEqual(["t", ciphertext, SCOPE]);
  });

  it("leaves what is not a host call as it was", () => {
    const raw = deps({
      upstreamFetch: async () => {
        throw new Error("not called");
      },
      now: () => 7,
      options: { followRedirects: true },
    });
    const guarded = guardHostDeps(raw);

    expect(guarded.upstreamFetch).toBe(raw.upstreamFetch);
    expect(guarded.log).toBe(raw.log);
    expect(guarded.now).toBe(raw.now);
    expect(guarded.options).toBe(raw.options);
  });
});

describe("refuseIncomplete", () => {
  it("answers 409 with the scheme's own message for a configuration error, and null otherwise", () => {
    expect(refuseIncomplete(new MissingSchemeParameterError("headerName"), 7)).toEqual({
      kind: "refused",
      status: 409,
      reason: "credential_incomplete",
      message: "scheme configuration is missing headerName",
      requestBytes: 7,
    });
    expect(refuseIncomplete(new Error("something else"), 7)).toBeNull();
  });
});

describe("deriveRefusal", () => {
  it("treats a misconfigured scheme as the connection's fault, as apply does", () => {
    expect(deriveRefusal(new MissingSchemeParameterError("tokenUrl"), 0)).toMatchObject({
      status: 409,
      reason: "credential_incomplete",
    });
  });

  it("refuses a token endpoint that failed the address rule, by its own word or by what it resolved to", () => {
    expect(
      deriveRefusal(new DerivedCredentialError("not public", "host_not_public"), 0),
    ).toMatchObject({
      status: 403,
      reason: "host_not_public",
      message: "The token endpoint is not a public address",
    });
    const resolvedPrivately = new DerivedCredentialError("unreachable", "token_exchange_failed", {
      cause: new PrivateAddressError("auth.vendor.example", "10.0.0.1"),
    });
    expect(deriveRefusal(resolvedPrivately, 0)).toMatchObject({
      status: 403,
      reason: "host_not_public",
    });
  });

  it("reads a timeout under the exchange as the call's one deadline", () => {
    const timedOut = new DerivedCredentialError("unreachable", "token_exchange_failed", {
      cause: named("TimeoutError"),
    });
    expect(deriveRefusal(timedOut, 0)).toMatchObject({
      status: 504,
      reason: "upstream_timeout",
      message: "The token endpoint did not answer within the time limit",
    });
  });

  it("answers 502 token_exchange_failed for anything else, carrying the endpoint's status and the cause", () => {
    const cause = named("ECONNRESET");
    const failed = new DerivedCredentialError(
      "The token endpoint answered 400",
      "token_exchange_failed",
      {
        cause,
        upstreamStatus: 400,
      },
    );
    expect(deriveRefusal(failed, 12)).toEqual({
      kind: "refused",
      status: 502,
      reason: "token_exchange_failed",
      message: "The token endpoint answered 400",
      requestBytes: 12,
      upstreamStatus: 400,
      failure: cause,
    });
  });

  it("rethrows an error that is not a derive failure, for proxyCall to record as the proxy's own", () => {
    const bug = new TypeError("undefined is not a function");
    expect(() => deriveRefusal(bug, 0)).toThrow(bug);
  });
});

describe("refuseUpstreamFailure", () => {
  it("names the resolver's refusal host_not_public, wherever it sits in the cause chain", () => {
    const wrapped = new Error("fetch failed", {
      cause: new PrivateAddressError("api.vendor.example", "169.254.169.254"),
    });
    expect(refuseUpstreamFailure(wrapped, 5)).toEqual({
      kind: "refused",
      status: 403,
      reason: "host_not_public",
      message: "The vendor host resolves to a private address",
      requestBytes: 5,
    });
  });

  it("names the deadline upstream_timeout", () => {
    expect(refuseUpstreamFailure(named("AbortError"), 5)).toMatchObject({
      status: 504,
      reason: "upstream_timeout",
      message: "The vendor did not answer within the time limit",
    });
  });

  it("names anything else unreachable and puts the error on the event", () => {
    const error = named("ECONNREFUSED");
    expect(refuseUpstreamFailure(error, 5)).toMatchObject({
      status: 502,
      reason: "upstream_unreachable",
      failure: error,
    });
  });
});

describe("the response-read refusals", () => {
  const detail = { requestBytes: 9, upstreamStatus: 200 };

  it("carry the vendor's status and the caller's body size", () => {
    expect(refuseResponseTooLarge({ maxBodyBytes: 1024 }, detail)).toEqual({
      kind: "refused",
      status: 502,
      reason: "response_too_large",
      message: "Response bodies are capped at 1024 bytes",
      ...detail,
    });
    expect(refuseResponseTimeout(detail)).toEqual({
      kind: "refused",
      status: 504,
      reason: "upstream_timeout",
      message: "The vendor did not finish answering within the time limit",
      ...detail,
    });
    const error = named("ECONNRESET");
    expect(refuseResponseUnreadable(error, detail)).toEqual({
      kind: "refused",
      status: 502,
      reason: "upstream_unreachable",
      message: "The vendor's response could not be read",
      ...detail,
      failure: error,
    });
  });
});
