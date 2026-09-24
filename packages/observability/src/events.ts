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
  // The account, from Better Auth's own hooks rather than a route (GRA-157): a person is counted
  // signed up the moment they exist *and* are verified — a password account when its address is
  // verified, a social account when it is created verified — so a squatted or abandoned sign-up
  // never counts. Property `method`: `email`, or the social provider's name. The one event that
  // carries a person property (`Capture.person`): the email, so the profile the rest of the
  // events land on has a name someone can act on while the alpha runs. `distinctId` stays the id.
  | "person_signed_up"
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
  // Setup (ADR 0024; GRA-204), at its routes: the start, on the harness step, and the skip. Property
  // `harness`: the harness picked, or null when Setup adopted an agent that already existed or was
  // skipped before a harness was picked. GRA-206 onwards adds `setup_step_completed` and
  // `setup_completed`.
  | "setup_started"
  | "setup_skipped"
  // A link provider's connect (ADR 0019), at the server's two link routes (GRA-147): whether the
  // provider's link could be minted, and how the person's return ended. Properties: `provider`,
  // and on the return `outcome` (connected | failed | declined). Counted so a provider that
  // cannot finish is seen rather than quietly worked around.
  | "provider_link_started"
  | "provider_link_fell_back"
  | "provider_link_returned"
  // Over MCP
  | "tool_called"
  // A blob a tool wrote (ADR 0023; GRA-186), once per blob, beside the `tool_called` of the run
  // that wrote it: `bytes`, `content_type` (a kind), `agent_id`, `version_id`. Never the name the
  // module gave it and never a byte of it.
  | "blob_written"
  // A blob directory the sweep removed (ADR 0023, "the sweep deletes"; GRA-189), once per removal:
  // `bytes` (null when an orphan held no data), `cause` (`expired` for a row past its time,
  // `orphan` for a committed directory with no row and no readable sidecar), `agent_id`. Never the
  // name and never a byte; a `.tmp` an abandoned write left is cleared without an event, since it
  // was never a blob, and junk under an agent the database no longer holds (GRA-195) is cleared
  // without one too, since there is no person to name.
  | "blob_swept"
  | "acquire_completed"
  | "acquire_failed";

/** A flat bag of scalars — what every analytics backend indexes; nested objects are one opaque value there. */
export type AnalyticsProperties = Record<string, string | number | boolean | null>;
