import type { AnalyticsEvent } from "@graft/analytics/events";
import type { MutationKey } from "@tanstack/react-query";

/**
 * Which of the console's mutations count as a product event (GRA-100), keyed by the `mutationKey`
 * the call site declares — `["agent", "create"]`, read as `agent.create`. One chokepoint,
 * `MutationCache.onSuccess` in `query-client.ts`, so a new mutation is tracked by declaring a key
 * and adding a line here, not by finding its dialog; a mutation with no key, or a key not listed,
 * is nobody's business. Failures never count: an event says something happened. The vocabulary
 * itself is `@graft/analytics/events`, shared with the server's captures, so both halves of a
 * person's story spell an event one way. Cando's `analytics-events.ts` is the shape (ADR 0011).
 *
 * Absent on purpose: the reads, the sign-in and sign-out (Better Auth's, and the guard identifies
 * the person on every navigation anyway), and the ask card's *decline* — an answer is an answer,
 * and `approval_answered` carries no `allow`, because whether a person trusts a tool is theirs.
 */
export const TRACKED_MUTATIONS: Readonly<Record<string, AnalyticsEvent>> = {
  "agent.create": "agent_created",
  "agent.revoke": "agent_revoked",
  "agent.scope": "scope_changed",
  "mcp-oauth.consent": "mcp_client_consented",
  "connection.create": "connection_created",
  "connection.revoke": "connection_revoked",
  "pending-action.connection": "connection_confirmed",
  "pending-action.credential": "credential_entered",
  "pending-action.answer": "approval_answered",
  "model-key.set": "model_key_set",
  "model-key.remove": "model_key_removed",
};

/** The event a mutation's key stands for, or `null` for one nobody charts. A key is a flat list of strings; anything else is not ours. */
export function mutationEvent(mutationKey: MutationKey | undefined): AnalyticsEvent | null {
  if (!mutationKey || mutationKey.length === 0) return null;
  if (!mutationKey.every((segment) => typeof segment === "string")) return null;
  return TRACKED_MUTATIONS[mutationKey.join(".")] ?? null;
}
