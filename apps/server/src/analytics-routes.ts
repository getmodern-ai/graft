import type { AnalyticsEvent } from "@graft/observability";

/**
 * Which of the JSON API's mutations count as a product event (GRA-100), keyed by method and path
 * — the console's chokepoint, in the server rather than in the browser, because the console
 * carries no analytics library (ADR 0002 as amended 2026-09-19). One middleware in `api.ts` reads
 * this table after a route has answered, so a new route is tracked by adding a line here, not by
 * finding its handler; a route not listed is nobody's business. A failed answer never counts: an
 * event says something happened. Cando's `analytics-events.ts` is the shape (ADR 0011), with the
 * route standing where its `mutationKey` stood.
 *
 * Absent on purpose: the reads, sign-in and sign-out (Better Auth's routes), and the *content* of
 * any answer — `approval_answered` carries no `allow`, because whether a person trusts a tool is
 * theirs. The MCP side's events (`tool_called`, the acquire job's end) come from the MCP hook and
 * the runner, not from here.
 */
export const TRACKED_ROUTES: ReadonlyArray<{
  method: "POST" | "PUT" | "DELETE" | "PATCH";
  path: RegExp;
  event: AnalyticsEvent;
}> = [
  { method: "POST", path: /^\/agents$/, event: "agent_created" },
  { method: "POST", path: /^\/agents\/[^/]+\/revoke$/, event: "agent_revoked" },
  { method: "PUT", path: /^\/agents\/[^/]+\/scope$/, event: "scope_changed" },
  { method: "POST", path: /^\/mcp-oauth\/consent$/, event: "mcp_client_consented" },
  { method: "POST", path: /^\/connections$/, event: "connection_created" },
  { method: "POST", path: /^\/connections\/[^/]+\/revoke$/, event: "connection_revoked" },
  { method: "POST", path: /^\/pending-actions\/[^/]+\/connection$/, event: "connection_confirmed" },
  { method: "POST", path: /^\/pending-actions\/[^/]+\/credential$/, event: "credential_entered" },
  { method: "POST", path: /^\/pending-actions\/[^/]+\/answer$/, event: "approval_answered" },
  { method: "PUT", path: /^\/me\/model-key$/, event: "model_key_set" },
  { method: "DELETE", path: /^\/me\/model-key$/, event: "model_key_removed" },
];

/**
 * The event a request stands for once it has succeeded, or `null` for one nobody charts. `path` is
 * the request's, with or without the `/api` mount — the API app sees the full path, a test may
 * not — and a query string is not part of it.
 */
export function routeEvent(method: string, path: string): AnalyticsEvent | null {
  const relative = path.replace(/\?.*$/, "").replace(/^\/api(?=\/)/, "");
  for (const route of TRACKED_ROUTES) {
    if (route.method === method && route.path.test(relative)) return route.event;
  }
  return null;
}
