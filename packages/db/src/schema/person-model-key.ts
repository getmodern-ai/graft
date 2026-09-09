import { relations } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";
import { bytea, owned } from "./columns";

/**
 * The providers a person may bring a key for — `@graft/model/provider`'s two. Spelled here because
 * the schema imports nothing of the model package (both are leaves); `apps/server`'s model suite
 * asserts the two lists equal, so a provider added to one without the other fails a test rather
 * than a person's job.
 */
export const modelKeyProvider = ["anthropic", "openai"] as const;
export type ModelKeyProvider = (typeof modelKeyProvider)[number];

/**
 * A person's own model key (ADR 0014: a person may bring their own key to the hosted form, and
 * their jobs then run on their provider and nobody else's). One row per person — the primary key
 * is the person — because a key is a setting, not a collection: entering another replaces it.
 *
 * Write-only after entry, like a connection's credential: `key_ciphertext` is the vault's envelope
 * under the person's id, read by the model resolver in `apps/server` and by nothing else, and the
 * row's public shape carries `key_set_at` and the provider and model ids, never the key. The model
 * ids and the base URL are optional; unset, `@graft/model/provider`'s defaults for the provider
 * apply, so a person who enters only a key gets the same models the deployment would have run.
 */
export const personModelKey = pgTable("person_model_key", {
  personId: text("person_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: modelKeyProvider }).notNull(),
  /** The authoring model id, or null for the provider's default. */
  authoringModel: text("authoring_model"),
  /** The triage model id, or null for the provider's default. */
  triageModel: text("triage_model"),
  /** Another endpoint speaking the provider's API, or null for the provider's own. */
  baseUrl: text("base_url"),
  /**
   * `{ apiKey }` envelope-encrypted by `@graft/vault` with the person's id and the model-key scope
   * in the encryption context (`@graft/core`'s `modelKeyScope`), so a ciphertext copied onto another
   * person's row fails to decrypt rather than handing them a key.
   */
  keyCiphertext: bytea("key_ciphertext").notNull(),
  /** When the key was last entered — what the console shows beside "set". */
  keySetAt: timestamp("key_set_at").notNull(),
  ...owned(),
});

export const personModelKeyRelations = relations(personModelKey, ({ one }) => ({
  person: one(user, { fields: [personModelKey.personId], references: [user.id] }),
}));

export type PersonModelKeyRow = typeof personModelKey.$inferSelect;
export type NewPersonModelKeyRow = typeof personModelKey.$inferInsert;
