import { eq } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { type NewPersonModelKeyRow, personModelKey } from "../schema/person-model-key";

/**
 * Query ownership for a person's model key (ADR 0014; ADR 0007: the key is the person's). One row
 * per person, so every statement here is a point read or write on `person_id` — the scope and the
 * key are the same column, and there is no unscoped read: the model resolver that decrypts a key
 * always knows whose job it is resolving for.
 */

export type { NewPersonModelKeyRow, PersonModelKeyRow } from "../schema/person-model-key";

export async function findPersonModelKey(db: DbOrTx, personId: string) {
  const [row] = await db
    .select()
    .from(personModelKey)
    .where(eq(personModelKey.personId, personId))
    .limit(1);
  return row ?? null;
}

/**
 * Enter or replace the person's key: one row per person, so a second entry overwrites the first in
 * the same statement — there is never a moment with two keys, or none, between the two.
 */
export async function upsertPersonModelKey(db: DbOrTx, input: NewPersonModelKeyRow) {
  const [row] = await db
    .insert(personModelKey)
    .values(input)
    .onConflictDoUpdate({
      target: personModelKey.personId,
      set: {
        provider: input.provider,
        authoringModel: input.authoringModel ?? null,
        triageModel: input.triageModel ?? null,
        baseUrl: input.baseUrl ?? null,
        keyCiphertext: input.keyCiphertext,
        keySetAt: input.keySetAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Upsert of person_model_key returned no row");
  return row;
}

/** Remove the person's key; the deployment's fixed model answers their jobs from then on. Null when there was none. */
export async function deletePersonModelKey(db: DbOrTx, personId: string) {
  const [row] = await db
    .delete(personModelKey)
    .where(eq(personModelKey.personId, personId))
    .returning();
  return row ?? null;
}
