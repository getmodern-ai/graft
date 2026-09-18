/**
 * The product events the analytics seam receives, named once — GRA-100, in Cando's shape (its
 * `analytics-events.ts`, ADR 0011).
 *
 * `noun_verbed`, past tense, snake case: `agent_created`, not `createAgent` or `Agent Created`. The
 * union is the whole vocabulary, so a typo at a call site is a type error rather than a new event
 * nobody charts. Properties carry counts and kinds, never content: a goal a person typed, a vendor
 * host, a tool's input and a credential stay in the product (ADR 0006's posture on secrets holds
 * for analytics as it does for chats).
 *
 * Every event is captured **server-side**, from two chokepoints: the console's actions at the JSON
 * API's mutation routes (`apps/server/src/analytics-routes.ts`), and what happens over MCP and
 * never in a browser — every tool call, every `acquire` job's end — from the MCP hook and the
 * runner. The console itself carries no analytics library (ADR 0002 as amended 2026-09-19): the
 * open form ships nothing that phones anywhere, and the hosted form's backing is the private
 * package's. Both chokepoints name the same person (`distinctId` is the person's id, never the
 * email), so one profile carries the whole story.
 */
export type AnalyticsEvent =
  // The console, at the API's mutation routes
  | "agent_created"
  | "agent_revoked"
  | "mcp_client_consented"
  | "connection_created"
  | "connection_confirmed"
  | "credential_entered"
  | "connection_revoked"
  | "approval_answered"
  | "scope_changed"
  | "model_key_set"
  | "model_key_removed"
  // Over MCP
  | "tool_called"
  | "acquire_completed"
  | "acquire_failed";

/** A flat bag of scalars — what every analytics backend indexes; nested objects are one opaque value there. */
export type AnalyticsProperties = Record<string, string | number | boolean | null>;
