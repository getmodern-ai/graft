import { relations } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { user } from "./auth";
import { owned } from "./columns";
import { toolVersion } from "./tool";

/**
 * A **blob**: a file one tool wrote for another to read, held for the agent that wrote it for a
 * bounded time and never shown to the model (CONTEXT.md; ADR 0023, GRA-186). The bytes are in the
 * blob store, a directory `<id>/` of `data` and `meta.json` under the agent's own blobs directory;
 * this row is what the server knows of it — written from the ledger the runner returns beside a
 * run's result, since the sandbox has no route to the database — and what the door reads before a
 * run (GRA-187: `blob_not_found`, `blob_expired`, `blob_quota`) and the sweep reads to remove what
 * has expired (GRA-189).
 *
 * `id` is the blob id the runner minted, the `<id>` in `blob://<id>`, so a ref is looked up by its
 * primary key. The person and the agent are both on the row (ADR 0007): the scope of a blob is the
 * agent, and every read names both ids in the statement (`repo/blob.ts`). `versionId` is the tool
 * version whose run wrote it, `set null` so the record outlives a version; null for a runner
 * invoked by hand or a detached run, where the poll that learns of the blob does not know the
 * version. `removedAt` is set by the sweep once the directory is gone; the row stays, so the door
 * can say expired rather than not found.
 */
export const blob = pgTable(
  "blob",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    versionId: text("version_id").references(() => toolVersion.id, { onDelete: "set null" }),
    /** The size of `data`. A bigint though the per-blob cap is 256 MiB today, so raising the cap is never a migration. */
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    /** The media type the module declared; nothing sniffs it. */
    contentType: text("content_type").notNull(),
    /** The name the module gave, if any: `invoice.pdf`. Shown to the agent, never read as a path. */
    name: text("name"),
    /** 24 hours from the write (ADR 0023), as the runner's sidecar says. */
    expiresAt: timestamp("expires_at").notNull(),
    /** When the sweep removed the directory. Null while the bytes are there. */
    removedAt: timestamp("removed_at"),
    ...owned(),
  },
  (table) => [
    index("blob_person_id_idx").on(table.personId),
    // The door's quota and the sweep's pass: this agent's blobs by when each expires.
    index("blob_agent_id_expires_at_idx").on(table.agentId, table.expiresAt),
    index("blob_version_id_idx").on(table.versionId),
  ],
);

export const blobRelations = relations(blob, ({ one }) => ({
  person: one(user, { fields: [blob.personId], references: [user.id] }),
  agent: one(agent, { fields: [blob.agentId], references: [agent.id] }),
  version: one(toolVersion, { fields: [blob.versionId], references: [toolVersion.id] }),
}));

export type BlobRow = typeof blob.$inferSelect;
export type NewBlobRow = typeof blob.$inferInsert;
