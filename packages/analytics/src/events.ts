/**
 * The product events PostHog receives, named once — GRA-100, in Cando's shape (its
 * `analytics-events.ts`, ADR 0011). Browser-safe on purpose: the console imports this module and
 * nothing else of the package, so a node-only import here is what breaks its `vite build`.
 *
 * `noun_verbed`, past tense, snake case: `agent_created`, not `createAgent` or `Agent Created`. The
 * union is the whole vocabulary, so a typo at a call site is a type error rather than a new event
 * nobody charts. Properties carry counts and kinds, never content: a goal a person typed, a vendor
 * host, a tool's input and a credential stay in the product (ADR 0006's posture on secrets holds
 * for analytics as it does for chats).
 *
 * Two sources write it. The console captures what a person does there — the events with a
 * `mutationKey` in `apps/web/src/lib/analytics-events.ts`. The server captures what happens over
 * MCP and never in a browser: every tool call, every `acquire` job's end. Both name the same person
 * (`distinctId` is the person's id, never the email), so one profile carries both halves.
 */
export type AnalyticsEvent =
  // The console
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
  // The server, over MCP
  | "tool_called"
  | "acquire_completed"
  | "acquire_failed";

/** A flat bag of scalars — what every analytics backend indexes; nested objects are one opaque value there. */
export type AnalyticsProperties = Record<string, string | number | boolean | null>;
