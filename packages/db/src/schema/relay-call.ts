import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { user } from "./auth";
import { owned } from "./columns";

/**
 * The **relay budget's count** (GRA-349; ADR 0019 as amended 2026-11-14): how many relayed calls
 * one agent made in one clock hour. A relayed call costs the deployment what its upstream charges,
 * and the budget is judged against these rows before each one leaves (`@graft/core`'s
 * `relay-budget`): the agent's current hour against the hourly ceiling, the person's last 24 hours
 * against the daily one. Kept in Postgres rather than in the process so a redeploy does not hand a
 * looping agent a fresh allowance.
 *
 * One row per agent and hour, incremented in place, so the table holds at most 48 rows per active
 * agent: the server deletes hours older than two days on the sweep's timer. The person is on the
 * row so the daily read is one indexed statement over the person's rows (ADR 0007), and both
 * cascade, so a deleted agent or person takes its counts with it.
 */
export const relayCallCount = pgTable(
  "relay_call_count",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The UTC hour the calls fell in, on the hour. */
    hourStart: timestamp("hour_start").notNull(),
    calls: integer("calls").notNull(),
    /** `created_at` is the hour's first call; `updated_at` its latest. */
    ...owned(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.hourStart] }),
    // The daily read: one person's hours since the window opened.
    index("relay_call_count_person_id_hour_start_idx").on(table.personId, table.hourStart),
    // The prune: every hour older than two days, whoever's.
    index("relay_call_count_hour_start_idx").on(table.hourStart),
  ],
);

export type RelayCallCountRow = typeof relayCallCount.$inferSelect;
