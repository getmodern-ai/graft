import { Kind, parse } from "graphql";

import { DESTRUCTIVE_ENDPOINTS } from "./destructive-endpoints.ts";
import { READ_ENDPOINTS, type ReadEndpoint } from "./read-endpoints.ts";

/**
 * Whether a request to a vendor is a **read** (ADR 0008 as amended 2026-10-10): a request that
 * cannot change the vendor's state, judged by its method, its GraphQL operation type, or the
 * reviewed table (`read-endpoints.ts`). One pure function with two callers, so they cannot
 * disagree: the check (`@graft/check`), which derives a tool's `readOnly` annotation from the
 * calls it can see, and the proxy's dry run (`app.ts`), which lets a read reach the vendor and
 * stops everything else at the preview.
 *
 * `isDestructiveRequest`, below, is the same pair's other judgement: whether a write is one the
 * person cannot take back (`destructive-endpoints.ts`, GRA-267).
 *
 * Anything this function cannot judge is a write. The check calls it with what it sees
 * statically: `host` null where the call names none, a `body` built from the literals it could
 * read. The proxy calls it with the request as it would leave.
 *
 * Imported by the check's worker thread, which Node loads natively: erasable syntax only, and
 * siblings by their `.ts` name (`module-check.core.ts` has the reason).
 */

export type RequestToClassify = {
  method: string;
  /** The vendor host, lower case; null where the caller cannot know it (a relative path, statically). */
  host: string | null;
  /** The URL's path, without its query string. */
  path: string;
  /** Whether the URL carries a query string. */
  hasQuery: boolean;
  /** The body as parsed JSON, or null where there is none or it is not JSON. */
  body: { json: unknown } | null;
};

export type RequestVerdict =
  | { read: true; by: "method" | "graphql" | "endpoint" }
  | { read: false };

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * The keys a GraphQL-over-HTTP request body may carry and still be judged. `extensions` is not
 * among them: an automatic persisted query names its document by hash there, and the document a
 * server runs is then not the one in the body.
 */
const GRAPHQL_BODY_KEYS: ReadonlySet<string> = new Set(["query", "variables", "operationName"]);

/** A GraphQL endpoint's last path segment: `/graphql`, or Shopify's `/graphql.json`. */
const GRAPHQL_SEGMENT = /^graphql(\.json)?$/;

/** What a wildcard segment in the table matches: a plain name, never `%2F`, `.` or `..`. */
const PLAIN_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** A bound on the parser's work for a body already capped in bytes by the proxy. */
const GRAPHQL_MAX_TOKENS = 20_000;

export function classifyRequest(request: RequestToClassify): RequestVerdict {
  const method = request.method.toUpperCase();
  if (READ_METHODS.has(method)) return { read: true, by: "method" };
  if (method === "POST" && isGraphqlQuery(request)) return { read: true, by: "graphql" };
  if (request.host !== null && READ_ENDPOINTS.some((entry) => matches(entry, method, request))) {
    return { read: true, by: "endpoint" };
  }
  return { read: false };
}

/**
 * A POST to a GraphQL endpoint, with no query string (a server may read the operation from one),
 * whose JSON body is an object of GraphQL's own keys, whose `query` parses as an executable
 * document of query operations alone. A REST write whose body happens to carry a `query` field is
 * kept out by the path and by the keys.
 */
function isGraphqlQuery(request: RequestToClassify): boolean {
  if (request.hasQuery) return false;
  const last = request.path.split("/").pop() ?? "";
  if (!GRAPHQL_SEGMENT.test(last)) return false;
  const json = request.body?.json;
  if (typeof json !== "object" || json === null || Array.isArray(json)) return false;
  const keys = Object.keys(json);
  if (!keys.every((key) => GRAPHQL_BODY_KEYS.has(key))) return false;
  const { query, operationName } = json as Record<string, unknown>;
  if (typeof query !== "string") return false;
  if (operationName !== undefined && operationName !== null && typeof operationName !== "string") {
    return false;
  }
  return onlyQueries(query);
}

/** Every definition an operation of type `query` or a fragment, and at least one operation. */
export function onlyQueries(document: string): boolean {
  let definitions: ReturnType<typeof parse>["definitions"];
  try {
    definitions = parse(document, { noLocation: true, maxTokens: GRAPHQL_MAX_TOKENS }).definitions;
  } catch {
    return false;
  }
  let operations = 0;
  for (const definition of definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) continue;
    if (definition.kind !== Kind.OPERATION_DEFINITION) return false;
    if (definition.operation !== "query") return false;
    operations += 1;
  }
  return operations > 0;
}

function matches(entry: ReadEndpoint, method: string, request: RequestToClassify): boolean {
  if (entry.method !== method || entry.host !== request.host) return false;
  const want = entry.path.split("/");
  const got = request.path.split("/");
  if (want.length !== got.length) return false;
  return want.every((segment, index) => {
    const actual = got[index] ?? "";
    return segment === "*" ? PLAIN_SEGMENT.test(actual) : segment === actual;
  });
}

/**
 * Whether a request is **destructive** (ADR 0008 as amended 2026-10-10, GRA-267): a `DELETE`, or
 * an entry of the reviewed table (`destructive-endpoints.ts`). The same two callers as
 * `classifyRequest`: the check derives a tool's `destructive` annotation from it, and the proxy
 * labels a dry run's preview with it.
 *
 * Where the host is known the entry's path is matched from the host's root. Where it is not (the
 * check, for a relative path, which goes to the connection's primary host under its base path)
 * the request's path is matched as the entry's path under a base path, on any host
 * (`matchesTail`): `/refunds` under Stripe's `/v1` is the entry `/v1/refunds`. Matching here leans the other way from the read
 * table's, since a false yes only asks the person more often: empty segments (a doubled or
 * trailing slash) are dropped and `*` matches any segment. A path the caller could not read
 * (`""`, or one not starting with `/`) matches nothing, and the request stays an ordinary write.
 */
export function isDestructiveRequest(request: RequestToClassify): boolean {
  const method = request.method.toUpperCase();
  if (method === "DELETE") return true;
  if (!request.path.startsWith("/")) return false;
  const got = nonEmptySegments(request.path);
  if (got.length === 0) return false;
  return DESTRUCTIVE_ENDPOINTS.some((entry) => {
    if (entry.method !== method) return false;
    const want = nonEmptySegments(entry.path);
    if (request.host !== null) return entry.host === request.host && sameSegments(want, got);
    return matchesTail(want, got);
  });
}

/**
 * Whether a path with no host is an entry's path under some base path: the entry's trailing
 * segments, starting at a literal one, with only literal segments dropped in front. So `/refunds`
 * and `/v1/refunds` are `/v1/refunds`, and `/payment_intents/pi_1/cancel` is the entry for
 * `/v1/payment_intents/<id>/cancel`, but `/pi_1/cancel` and `/cancel` are not: a tail that begins
 * at a wildcard, or drops one, would make every `POST …/cancel` destructive.
 */
function matchesTail(want: readonly string[], got: readonly string[]): boolean {
  if (got.length > want.length) return false;
  const start = want.length - got.length;
  if (want[start] === "*" || want.slice(0, start).includes("*")) return false;
  return sameSegments(want.slice(start), got);
}

function nonEmptySegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function sameSegments(want: readonly string[], got: readonly string[]): boolean {
  return (
    want.length === got.length &&
    want.every((segment, index) => segment === "*" || segment === got[index])
  );
}

/** A request body as `RequestToClassify.body`: well-formed UTF-8 that parses as JSON, else null. */
export function parseJsonBody(bytes: Uint8Array | null): { json: unknown } | null {
  if (bytes === null || bytes.byteLength === 0) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { json: JSON.parse(text) };
  } catch {
    return null;
  }
}
