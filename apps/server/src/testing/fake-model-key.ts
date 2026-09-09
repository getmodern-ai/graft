import type { ModelKeyDeps } from "@graft/core";
import type { PersonModelKeyRow } from "@graft/db/repo/person-model-key";

/**
 * `ModelKeyDeps` over a map, for the server suites that build `ApiDeps`: the rows by person, a
 * vault whose encrypt answers a marker ciphertext, and a fixed clock. What a suite reads back
 * through it is the row, never a key — the service never stores one.
 */
export const FAKE_MODEL_KEY_CIPHERTEXT = Buffer.from("fake-model-key-ciphertext");

export function fakeModelKeyDeps(
  options: { now?: () => Date; rows?: PersonModelKeyRow[] } = {},
): ModelKeyDeps & { rows: Map<string, PersonModelKeyRow> } {
  const now = options.now ?? (() => new Date("2026-09-09T10:00:00Z"));
  const rows = new Map((options.rows ?? []).map((row) => [row.personId, row]));
  return {
    rows,
    findPersonModelKey: async (_db, personId) => rows.get(personId) ?? null,
    upsertPersonModelKey: async (_db, input) => {
      const row: PersonModelKeyRow = {
        personId: input.personId,
        provider: input.provider,
        authoringModel: input.authoringModel ?? null,
        triageModel: input.triageModel ?? null,
        baseUrl: input.baseUrl ?? null,
        keyCiphertext: input.keyCiphertext,
        keySetAt: input.keySetAt,
        owner: "person",
        createdAt: rows.get(input.personId)?.createdAt ?? now(),
        updatedAt: now(),
      };
      rows.set(row.personId, row);
      return row;
    },
    deletePersonModelKey: async (_db, personId) => {
      const row = rows.get(personId) ?? null;
      rows.delete(personId);
      return row;
    },
    vault: { encrypt: async () => FAKE_MODEL_KEY_CIPHERTEXT },
    now,
  };
}
