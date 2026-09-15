import { relations } from "drizzle-orm";
import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";
import { owned, ownedRecord } from "./columns";
import { connection } from "./connection";
import { mcpClient } from "./mcp-oauth";

/**
 * An **agent**: one harness connection to Graft, authenticating with its own token (CONTEXT.md).
 * It belongs to a person and holds a scope, a working-set cap and an idle window, and nothing
 * else of its own (ADR 0007) — connections and the toolbox are the person's, referenced from
 * here, never owned here.
 */
export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** What the console shows: "laptop Hermes", "ops OpenClaw". */
    name: text("name").notNull(),
    /**
     * SHA-256 of the bearer token, hex. The token itself is shown once, at creation, and never
     * stored: a database copy must not be a set of harness credentials. The unique index is what
     * makes `findAgentByTokenHash` a point read, and what makes a token resolve to one agent and
     * no other. Null for an agent an MCP client's consent minted (ADR 0018): that agent is reached
     * through the tokens in `mcp_token` and holds no static token at all — a token nobody was ever
     * shown would be a credential with no holder.
     */
    tokenHash: text("token_hash").unique(),
    /** The token's first characters, so a person can tell two tokens apart in the console; null with `token_hash`. */
    tokenPrefix: text("token_prefix"),
    /**
     * The MCP client whose consent minted this agent, when one did (ADR 0018) — the registration
     * row, and the client's name as it was at consent, kept beside it so the console still says
     * "Claude" if the registration is later re-made under another name or gone. Both null for an
     * agent created in the console with a static token.
     */
    connectedViaClientId: text("connected_via_client_id").references(() => mcpClient.id, {
      onDelete: "set null",
    }),
    connectedViaClientName: text("connected_via_client_name"),
    /** ADR 0009's cap: how many tools may be promoted at once. */
    workingSetCap: integer("working_set_cap").notNull().default(20),
    /** ADR 0009's idle window: a tool unused this many days is demoted by the rule. */
    idleWindowDays: integer("idle_window_days").notNull().default(21),
    /**
     * Set when the person revokes the agent. The row stays — its working-set history and ledger
     * lines are the person's records (ADR 0012) — but its token resolves to nothing from then on.
     */
    revokedAt: timestamp("revoked_at"),
    ...owned(),
  },
  (table) => [
    index("agent_person_id_idx").on(table.personId),
    index("agent_connected_via_client_id_idx").on(table.connectedViaClientId),
  ],
);

/**
 * The **scope**: the connections an agent may use (CONTEXT.md, ADR 0007). The capability token
 * minted for an exec names connections from this set and no others, so an authored tool running
 * for one agent cannot reach a connection that agent was never given.
 */
export const agentConnection = pgTable(
  "agent_connection",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    ...ownedRecord(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.connectionId] }),
    // `agent_id` leads the primary key; the other foreign key needs its own index.
    index("agent_connection_connection_id_idx").on(table.connectionId),
  ],
);

export const agentRelations = relations(agent, ({ one, many }) => ({
  person: one(user, { fields: [agent.personId], references: [user.id] }),
  scope: many(agentConnection),
}));

export const agentConnectionRelations = relations(agentConnection, ({ one }) => ({
  agent: one(agent, { fields: [agentConnection.agentId], references: [agent.id] }),
  connection: one(connection, {
    fields: [agentConnection.connectionId],
    references: [connection.id],
  }),
}));

export type Agent = typeof agent.$inferSelect;
export type NewAgent = typeof agent.$inferInsert;
export type AgentConnection = typeof agentConnection.$inferSelect;
