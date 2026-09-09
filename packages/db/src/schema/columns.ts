import { customType, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The columns every owned table carries, in one place so the owner tier cannot be forgotten on the
 * next table (ADR 0007: the org tier exists in the schema from the first table and has no UI).
 *
 * `owner` says which tier the row belongs to. Every row is `person` at launch and nothing reads the
 * column; it exists so that sharing later is a value, not a migration. `schema.test.ts` asserts the
 * column, its default and its enum on every table that is not Better Auth's.
 */
export const ownerTier = ["person", "org"] as const;
export type OwnerTier = (typeof ownerTier)[number];

/** The rows a service edits: the tier, and both timestamps. */
export function owned() {
  return {
    ...ownedRecord(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  };
}

/**
 * The rows nothing edits once written — a tool version, a working-set change, a ledger line. The
 * tier and the moment of writing, and no `updated_at`, because a column nothing maintains is a
 * claim the next reader trusts (ADR 0012 wants these records, and wants them honest).
 */
export function ownedRecord() {
  return {
    owner: text("owner", { enum: ownerTier }).notNull().default("person"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  };
}

/**
 * Postgres `bytea`, which drizzle-orm 0.45 has no first-class column for. Bytes rather than base64
 * text because `pg` already speaks `Buffer` in both directions for this type — the vault hands back
 * a `Buffer` and the proxy hands one in — so there is no encode step to get wrong and an opaque
 * ciphertext stays opaque in the column as well as in the code.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
