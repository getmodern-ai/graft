import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { owned } from "./columns";

/**
 * Graft as an OAuth 2.1 authorization server for the MCP endpoint (ADR 0018): the three records
 * behind a chat product connecting over MCP OAuth rather than a static agent token. "Client" in
 * this file is RFC 6749's word for the software that registered — Claude, ChatGPT, the MCP
 * Inspector — and never an agent (CONTEXT.md, *MCP client*); the agent is the token's subject, and
 * every token row names it.
 *
 * Nothing here is a secret at rest: a client secret, an authorization code and every token are
 * stored as the SHA-256 of the value, the way `agent.token_hash` is, so a database copy holds no
 * credential a client could present.
 */

/** How a client proves itself at the token endpoint (RFC 7591 `token_endpoint_auth_method`). */
export const mcpClientAuthMethod = ["none", "client_secret_basic", "client_secret_post"] as const;
export type McpClientAuthMethod = (typeof mcpClientAuthMethod)[number];

/**
 * An **MCP client** registration (RFC 7591): what a chat product told Graft about itself when it
 * connected, and what the consent page shows the person. Registration is unauthenticated, as the
 * products require, so a row is nobody's until a consent binds an agent to it; the tier column is
 * carried for the uniformity ADR 0007 asks of every table, not because a person owns the row.
 */
export const mcpClient = pgTable("mcp_client", {
  /** The `client_id` the client presents — random, so it cannot be guessed from another's. */
  id: text("id").primaryKey(),
  /** SHA-256 of the client secret, hex; null for a public client (`token_endpoint_auth_method: none`). */
  secretHash: text("secret_hash"),
  /** The registered `client_name`, trimmed, or the placeholder when none was given — the consent page's headline. */
  name: text("name").notNull(),
  /** Exact-match redirect URIs (RFC 6749 §3.1.2.2); an authorization request naming another is refused without redirecting. */
  redirectUris: text("redirect_uris").array().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method", { enum: mcpClientAuthMethod })
    .notNull()
    .default("client_secret_basic"),
  grantTypes: text("grant_types").array().notNull(),
  responseTypes: text("response_types").array().notNull(),
  /** The OAuth `scope` string the client registered, echoed back; Graft attaches no meaning to it. */
  scope: text("scope"),
  clientUri: text("client_uri"),
  logoUri: text("logo_uri"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  ...owned(),
});

/**
 * An authorization code (RFC 6749 §4.1.2): one consent's answer on its way back to the client,
 * bound to the agent the consent minted or named, the redirect URI it was sent to, the PKCE
 * challenge the exchange must answer, and the resource the token will be for. Ten minutes long and
 * single-use; `consumed_at` is what makes the second exchange fail, in the statement.
 */
export const mcpAuthorizationCode = pgTable(
  "mcp_authorization_code",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the code, hex — the exchange looks it up by this and never stores the code. */
    codeHash: text("code_hash").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpClient.id, { onDelete: "cascade" }),
    /** The agent the consent bound this grant to — the subject of every token the code yields (ADR 0018). */
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    /** The RFC 8707 resource the client asked for — the MCP endpoint's canonical URL, or null when it sent none. */
    resource: text("resource"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    ...owned(),
  },
  (table) => [
    index("mcp_authorization_code_client_id_idx").on(table.clientId),
    index("mcp_authorization_code_agent_id_idx").on(table.agentId),
  ],
);

export const mcpTokenKind = ["access", "refresh"] as const;
export type McpTokenKind = (typeof mcpTokenKind)[number];

/**
 * An access or refresh token a client holds for an agent — both opaque, both stored hashed, in one
 * table because the MCP door resolves one and the token endpoint rotates the other by the same
 * lookup. `grant_id` is the authorization code that started the grant: revoking a refresh token, or
 * seeing a rotated one presented again past the grace window, revokes every row of the grant
 * (RFC 7009 §2.1; OAuth 2.1 §4.3.1). An access token expires by `expires_at`; a refresh token has
 * none and lives exactly as long as the agent — the resolving read joins `agent.revoked_at`, so
 * revoking the agent refuses every token at once without touching these rows, and
 * `revokeMcpTokensForAgent` stamps them anyway so the record says what happened.
 */
export const mcpToken = pgTable(
  "mcp_token",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the token, hex — the door's point read, and what makes a token resolve to one agent. */
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind", { enum: mcpTokenKind }).notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpClient.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /** The authorization code's id — the grant this token belongs to; every token of a grant shares it. */
    grantId: text("grant_id").notNull(),
    resource: text("resource"),
    scope: text("scope"),
    /** Null for a refresh token, which lives with the agent. */
    expiresAt: timestamp("expires_at"),
    /** A refresh token that has been exchanged for its successor; presented again past the grace window, it is a replay. */
    rotatedAt: timestamp("rotated_at"),
    revokedAt: timestamp("revoked_at"),
    ...owned(),
  },
  (table) => [
    index("mcp_token_client_id_idx").on(table.clientId),
    index("mcp_token_agent_id_idx").on(table.agentId),
    // "Every token of this grant" — what a revoke and a replay both reach for.
    index("mcp_token_grant_id_idx").on(table.grantId),
  ],
);

export const mcpClientRelations = relations(mcpClient, ({ many }) => ({
  codes: many(mcpAuthorizationCode),
  tokens: many(mcpToken),
}));

export const mcpAuthorizationCodeRelations = relations(mcpAuthorizationCode, ({ one }) => ({
  client: one(mcpClient, { fields: [mcpAuthorizationCode.clientId], references: [mcpClient.id] }),
  agent: one(agent, { fields: [mcpAuthorizationCode.agentId], references: [agent.id] }),
}));

export const mcpTokenRelations = relations(mcpToken, ({ one }) => ({
  client: one(mcpClient, { fields: [mcpToken.clientId], references: [mcpClient.id] }),
  agent: one(agent, { fields: [mcpToken.agentId], references: [agent.id] }),
}));

export type McpClient = typeof mcpClient.$inferSelect;
export type NewMcpClient = typeof mcpClient.$inferInsert;
export type McpAuthorizationCode = typeof mcpAuthorizationCode.$inferSelect;
export type NewMcpAuthorizationCode = typeof mcpAuthorizationCode.$inferInsert;
export type McpToken = typeof mcpToken.$inferSelect;
export type NewMcpToken = typeof mcpToken.$inferInsert;
