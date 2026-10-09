import { Kind, parse } from "graphql";

import { READ_ENDPOINTS, type ReadEndpoint } from "./read-endpoints.ts";

/**
 * Whether a request to a vendor is a **read** (ADR 0008 as amended 2026-10-10): a request that
 * cannot change the vendor's state, judged by its method, its GraphQL operation type, or the
 * reviewed table (`read-endpoints.ts`). One pure function with two callers, so they cannot
 * disagree: the check (`@graft/check`), which derives a tool's `readOnly` annotation from the
 * calls it can see, and the proxy's dry run (`app.ts`), which lets a read reach the vendor and
 * stops everything else at the preview.
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
