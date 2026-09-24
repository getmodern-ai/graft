import type { AnalyticsEvent, AnalyticsProperties } from "@graft/observability";

/**
 * Which of the JSON API's mutations count as a product event (GRA-100), keyed by method and path
 * — the console's chokepoint, in the server rather than in the browser, because the console
 * carries no analytics library (ADR 0002 as amended 2026-09-19). One middleware in `api.ts` reads
 * this table after a route has answered, so a new route is tracked by adding a line here, not by
 * finding its handler; a route not listed is nobody's business. A failed answer never counts: an
 * event says something happened. Cando's `analytics-events.ts` is the shape (ADR 0011), with the
 * route standing where its `mutationKey` stood.
 *
 * Absent on purpose: the reads, sign-in and sign-out (Better Auth's routes) — the sign-up is counted
 * too, but from Better Auth's own hooks rather than its route, since the route answers the same
 * for a taken address and a squatted one (`@graft/auth`'s `onPersonSignedUp`, GRA-157) — and the
 * *content* of any answer — `approval_answered` carries no `allow`, because whether a person trusts a tool is
 * theirs. The MCP side's events (`tool_called`, the acquire job's end) come from the MCP hook and
 * the runner, not from here.
 *
 * A row may name `properties`: a function over the route's JSON answer that picks the kinds the
 * event carries, so the route still knows nothing of analytics and the event carries what the
 * answer already said (Setup's `harness`, GRA-204). Kinds only, never content, as the vocabulary
 * in `@graft/observability` says.
 */
export type TrackedRoute = {
  method: "POST" | "PUT" | "DELETE" | "PATCH";
  path: RegExp;
  event: AnalyticsEvent;
  properties?: (answer: unknown) => AnalyticsProperties;
};

/** The harness on a Setup state answer (`SetupState` in `@graft/core`), or null for none. */
export function setupHarnessProperty(answer: unknown): AnalyticsProperties {
  const setup =
    typeof answer === "object" && answer !== null ? (answer as { setup?: unknown }).setup : null;
  const harness =
    typeof setup === "object" && setup !== null ? (setup as { harness?: unknown }).harness : null;
  return { harness: typeof harness === "string" ? harness : null };
}

/** A Setup step's completion: the step the route completes, beside the harness on the answer. */
export function setupStepProperties(step: string): (answer: unknown) => AnalyticsProperties {
  return (answer) => ({ step, ...setupHarnessProperty(answer) });
}

export const TRACKED_ROUTES: ReadonlyArray<TrackedRoute> = [
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
  {
    method: "POST",
    path: /^\/setup\/start$/,
    event: "setup_started",
    properties: setupHarnessProperty,
  },
  // The vendor step completes when a vendor is chosen; the connect step's completion is counted
  // where the connection is learned (`api.ts`, "The connect step"), since that may be a read.
  {
    method: "POST",
    path: /^\/setup\/connect$/,
    event: "setup_step_completed",
    properties: setupStepProperties("vendor"),
  },
  {
    method: "POST",
    path: /^\/setup\/skip$/,
    event: "setup_skipped",
    properties: setupHarnessProperty,
  },
];

/**
 * The event a request stands for once it has succeeded, or `null` for one nobody charts. `path` is
 * the request's, with or without the `/api` mount — the API app sees the full path, a test may
 * not — and a query string is not part of it.
 */
export function routeEvent(method: string, path: string): AnalyticsEvent | null {
  return trackedRoute(method, path)?.event ?? null;
}

/** The row a request matches, for the chokepoint that also reads its `properties`; null for none. */
export function trackedRoute(method: string, path: string): TrackedRoute | null {
  const relative = path.replace(/\?.*$/, "").replace(/^\/api(?=\/)/, "");
  for (const route of TRACKED_ROUTES) {
    if (route.method === method && route.path.test(relative)) return route;
  }
  return null;
}
