import type { ContentfulStatusCode } from "hono/utils/http-status";

import { causeChain, describeCauseChain } from "./cause-chain";
import {
  CredentialRefreshError,
  credentialIncompleteRefusal,
  DerivedCredentialError,
} from "./schemes";
import type { ProxyDeps, ProxyOptions, ProxyOutcome } from "./types";
import { isPrivateAddressFailure, isTimeoutFailure } from "./upstream";

/**
 * How a call is refused — one constructor, one body shape, one translation of a failure onto the
 * wide event. `ProxyOutcome` in `types.ts` is the vocabulary; this file is where a word gets its
 * status and its message, so the `{ error, reason, message }` the agent's code reads and the
 * `outcome` the operator greps cannot be assembled two ways.
 *
 * The boundary: a refusal one rung alone answers is written at that rung in `app.ts`, through
 * `refuse`; a refusal two rungs share, or one that has to classify an error before it can choose a
 * word, is a function here — so a status, a message or what the event learns is changed once.
 *
 * The other boundary drawn here is the host's. `guardHostDeps` wraps every function `ProxyDeps`
 * binds so that what it throws reaches the event as a `HostDependencyError` — the dependency and
 * the class names, never the message. `ProxyEvent.failure` promises never to carry a body, and a
 * vault's message is the one thing on the failure path the proxy cannot inspect for one; the
 * promise is kept by construction rather than by reading the text.
 */

/** A refusal in flight: what `proxyCall` turns into the JSON answer and the wide event. */
export type Refused = {
  kind: "refused";
  status: ContentfulStatusCode;
  reason: ProxyOutcome;
  message: string;
  /**
   * The vendor's status when it had answered before the refusal — a body too large, an unusable
   * status.
   */
  upstreamStatus?: number;
  /** The caller's body size when it had been read before the refusal. */
  requestBytes?: number;
  /** The error behind the refusal, for `describeFailure`; never a body. */
  failure?: unknown;
};

/** What a refusal may carry beyond its three words. */
export type RefusalDetail = Omit<Refused, "kind" | "status" | "reason" | "message">;

/**
 * What the vendor leg knows when it refuses: the caller's body size and, once answered, the
 * vendor's status.
 */
export type UpstreamDetail = { requestBytes: number; upstreamStatus?: number };

export function refuse(
  status: ContentfulStatusCode,
  reason: ProxyOutcome,
  message: string,
  extra: RefusalDetail = {},
): Refused {
  return { kind: "refused", status, reason, message, ...extra };
}

/**
 * The `error` word beside a refusal's `reason`: the status's own name, for a reader who knows HTTP
 * and not the proxy. A status with no word here answers `error`.
 */
const ERROR_WORDS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  408: "request_timeout",
  409: "conflict",
  413: "payload_too_large",
  500: "internal",
  501: "not_implemented",
  502: "bad_gateway",
  503: "unavailable",
  504: "gateway_timeout",
};

/** The body every refusal answers — `reason` is the wide event's word, so both readers read one. */
export function refusalBody(status: number, reason: ProxyOutcome, message: string) {
  return { error: ERROR_WORDS[status] ?? "error", reason, message };
}

/**
 * The wide event's `failure`: `name: message` down the cause chain of the error behind a refusal
 * (`cause-chain.ts`), or null when the refusal carried none. Never a stack, never a body — the
 * walker reads nothing else, and what a host-injected dependency threw arrives here already reduced
 * to class names (`HostDependencyError`), so the only messages that reach a log line are the
 * proxy's own and the network's.
 */
export function describeFailure(failure: unknown): string | null {
  return failure === undefined ? null : describeCauseChain(failure);
}

/** The host-bound functions of `ProxyDeps`, by the name the event records when one throws. */
export type HostDependency =
  | "verifyToken"
  | "jwks"
  | "connections.get"
  | "decryptCredential"
  | "storeCredential"
  | "credentialRefreshFailed"
  /** A relayed connection's `obtain` — the host's, handed over on the row rather than on `ProxyDeps` (ADR 0019). */
  | "relay.obtain";

/**
 * What a host-injected dependency threw, as the proxy is allowed to know it: which dependency, and
 * the class names down the thrown error's cause chain. Never the message — a vault's message is the
 * host's to compose, and the proxy cannot know whether a body, a query or a credential is in it —
 * and no `cause`, so the original never sits behind this one for a chain walker to reach. The
 * proxy's own errors and the network's keep their messages: a scheme error names a field or a
 * parameter, an undici failure names a host and a code, and a vendor body rides in neither.
 */
export class HostDependencyError extends Error {
  constructor(
    public readonly dependency: HostDependency,
    thrown: unknown,
  ) {
    super(`${dependency} threw ${describeThrownNames(thrown)}`);
    this.name = "HostDependencyError";
  }
}

/**
 * The names down a cause chain and nothing else — a non-Error link is its type, a chain past the
 * cap ends in `...` as `describeCauseChain`'s does, and a thrown `undefined` or `null` is spelled.
 */
function describeThrownNames(thrown: unknown): string {
  const { links, truncated } = causeChain(thrown);
  if (links.length === 0) return String(thrown);
  const names = links.map((link) => (link instanceof Error ? link.name || "Error" : typeof link));
  if (truncated) names.push("...");
  return names.join(" <- ");
}

/**
 * `ProxyDeps` with every host-bound function wrapped so that what it throws leaves as a
 * `HostDependencyError` — one place for the boundary, so a rung that calls the host does not have
 * to remember it. `createProxyApp` reads the host through this and never through the raw deps.
 * `upstreamFetch` is deliberately not wrapped: it is the proxy's own way out by default
 * (`upstream.ts`), a fetch failure carries no vendor body — a vendor's answer arrives as a response,
 * never as a throw — and its message is the `ECONNREFUSED` or `ENOTFOUND` the operator needs. `log`
 * is not wrapped because nothing is left to record its failure to; `now` and `options` are values.
 */
export function guardHostDeps(deps: ProxyDeps): ProxyDeps {
  const { storeCredential, credentialRefreshFailed } = deps;
  return {
    ...deps,
    verifyToken: (token) => fromHost("verifyToken", () => deps.verifyToken(token)),
    jwks: () => fromHost("jwks", () => deps.jwks()),
    connections: {
      get: (connectionId) => fromHost("connections.get", () => deps.connections.get(connectionId)),
    },
    decryptCredential: (ciphertext, scope) =>
      fromHost("decryptCredential", () => deps.decryptCredential(ciphertext, scope)),
    ...(storeCredential
      ? {
          storeCredential: (scope, fields) =>
            fromHost("storeCredential", () => storeCredential(scope, fields)),
        }
      : {}),
    ...(credentialRefreshFailed
      ? {
          credentialRefreshFailed: (scope, detail) =>
            fromHost("credentialRefreshFailed", () => credentialRefreshFailed(scope, detail)),
        }
      : {}),
  };
}

/**
 * One host-bound call under the boundary above. Exported for the one host function that arrives on
 * a connection rather than on `ProxyDeps` — a relay's `obtain` (`credential-source.ts`) — so it is
 * held to the same rule as the rest: its class names reach the event, its message never does.
 */
export async function fromHost<T>(dependency: HostDependency, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (thrown) {
    throw new HostDependencyError(dependency, thrown);
  }
}

/**
 * A misconfigured scheme is the connection's fault, not the proxy's: 409, with the scheme's own
 * message — `credentialIncompleteRefusal` in `schemes.ts` is the mapping, shared with the dry run's
 * preview. Null when the error is something else, which the caller decides about.
 */
export function refuseIncomplete(error: unknown, requestBytes: number): Refused | null {
  const refusal = credentialIncompleteRefusal(error);
  return refusal ? refuse(409, refusal.reason, refusal.message, { requestBytes }) : null;
}

/**
 * What a failed `derive` earns. A misconfigured scheme is the connection's fault (409, as for
 * `apply`); a token endpoint that failed the address rule or resolved privately is refused as any
 * private host is; a timeout is the call's one deadline; anything else the endpoint did — refused
 * the client, answered no token, could not be reached — is `token_exchange_failed`, a 502 because
 * the vendor's own answer was never obtained and the caller should not read it as one. An error
 * that is none of these is not a derive failure and is rethrown for `proxyCall` to record.
 */
export function deriveRefusal(error: unknown, requestBytes: number): Refused {
  const incomplete = refuseIncomplete(error, requestBytes);
  if (incomplete) return incomplete;
  if (error instanceof CredentialRefreshError) {
    // No token to send: the person has not consented yet (ADR 0005). A `refresh_failed` never
    // reaches here from the ladder — `credential-source.ts` sends the stored token stale instead —
    // but a caller that asks anyway gets the exchange's own word.
    if (error.reason === "consent_required") {
      return refuse(409, "consent_required", error.message, { requestBytes });
    }
    return refuse(502, "token_exchange_failed", error.message, {
      requestBytes,
      ...(error.upstreamStatus === null ? {} : { upstreamStatus: error.upstreamStatus }),
      failure: error.cause,
    });
  }
  if (error instanceof DerivedCredentialError) {
    if (error.reason === "host_not_public" || isPrivateAddressFailure(error.cause)) {
      return refuse(403, "host_not_public", "The token endpoint is not a public address", {
        requestBytes,
      });
    }
    if (isTimeoutFailure(error.cause)) {
      return refuse(
        504,
        "upstream_timeout",
        "The token endpoint did not answer within the time limit",
        { requestBytes },
      );
    }
    return refuse(502, "token_exchange_failed", error.message, {
      requestBytes,
      upstreamStatus: error.upstreamStatus,
      failure: error.cause,
    });
  }
  throw error;
}

/**
 * The vendor fetch threw. The resolver's own refusal is `host_not_public` — the name passed the
 * literal check and then resolved somewhere a credential must not go (`upstream.ts`); the call's
 * deadline is `upstream_timeout`; anything else is the vendor unreachable, with the failure on the
 * event so the operator can see which.
 */
export function refuseUpstreamFailure(error: unknown, requestBytes: number): Refused {
  if (isPrivateAddressFailure(error)) {
    return refuse(403, "host_not_public", "The vendor host resolves to a private address", {
      requestBytes,
    });
  }
  if (isTimeoutFailure(error)) {
    return refuse(504, "upstream_timeout", "The vendor did not answer within the time limit", {
      requestBytes,
    });
  }
  return refuse(502, "upstream_unreachable", "The vendor could not be reached", {
    requestBytes,
    failure: error,
  });
}

/**
 * The vendor's body would not fit under the cap — whether its declared length said so before a
 * byte was read, or the read found out. 502 because no vendor answer reaches the caller.
 */
export function refuseResponseTooLarge(
  options: Pick<ProxyOptions, "maxBodyBytes">,
  detail: UpstreamDetail,
): Refused {
  return refuse(
    502,
    "response_too_large",
    `Response bodies are capped at ${options.maxBodyBytes} bytes`,
    detail,
  );
}

/**
 * The vendor answered but did not finish before the call's deadline — whether the capped read
 * reported the abort or the stream threw it. One refusal for both, because they are one event.
 */
export function refuseResponseTimeout(detail: UpstreamDetail): Refused {
  return refuse(
    504,
    "upstream_timeout",
    "The vendor did not finish answering within the time limit",
    detail,
  );
}

/**
 * The vendor's body could not be read for a reason that was not the deadline; the failure says
 * which.
 */
export function refuseResponseUnreadable(error: unknown, detail: UpstreamDetail): Refused {
  return refuse(502, "upstream_unreachable", "The vendor's response could not be read", {
    ...detail,
    failure: error,
  });
}
