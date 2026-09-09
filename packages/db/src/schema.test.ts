import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "./schema";
import { account, session, user, verification } from "./schema/auth";
import { ownerTier } from "./schema/columns";

/**
 * The schema's standing rules, asserted rather than only declared — what drizzle emits into the
 * migration is the thing that reaches Postgres, and a word flipped in a schema file is invisible in
 * review to anyone who has not read the note beside it.
 *
 * **Not colocated in `src/schema/`, which is the one place it must not be**: drizzle-kit loads every
 * `.ts` under that directory, and a `vitest` import there breaks `db:generate` with a stack trace
 * naming this file rather than the cause. `schema/index.ts` says the same thing for the next reader.
 */

/** Every table drizzle-kit sees, minus Better Auth's four, which the CLI generates and we do not own. */
const authTables = new Set<PgTable>([user, session, account, verification]);
// Widened first: the module's values are a union of concrete table and relation types, over which a
// `PgTable` predicate is not expressible; over `unknown` it is.
const ownedTables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

const owned = ownedTables.filter((table) => !authTables.has(table)).map(getTableConfig);

describe("every owned table", () => {
  it("is found — the filter above must see the tables GRA-6 adds, or the assertions below prove nothing", () => {
    expect(owned.map((table) => table.name).sort()).toEqual([
      "acquire_attempt",
      "acquire_job",
      "acquire_trace",
      "agent",
      "agent_connection",
      "approval",
      "authored_tool",
      "build_approval",
      "connection",
      "pending_action",
      "person_model_key",
      "tool_version",
      "usage_ledger",
      "working_set",
      "working_set_change",
    ]);
  });

  /** ADR 0007: the org tier is a column from the first table, `person` on every row at launch. */
  it.each(owned.map((table) => [table.name, table] as const))(
    "%s carries `owner` in { person, org }, not null, defaulting to person",
    (_name, table) => {
      const owner = table.columns.find((column) => column.name === "owner");
      expect(owner).toBeDefined();
      expect(owner?.notNull).toBe(true);
      expect(owner?.default).toBe("person");
      expect(owner?.enumValues).toEqual([...ownerTier]);
    },
  );

  it.each(owned.map((table) => [table.name, table] as const))(
    "%s carries `created_at`, not null, defaulting to now",
    (_name, table) => {
      const createdAt = table.columns.find((column) => column.name === "created_at");
      expect(createdAt?.notNull).toBe(true);
      expect(createdAt?.hasDefault).toBe(true);
    },
  );

  /**
   * Every foreign key is indexed — either by an index of its own or by leading a primary key — so a
   * cascade from `user` or `agent` never has to scan a child table to find its rows.
   */
  it.each(owned.map((table) => [table.name, table] as const))(
    "%s indexes every foreign key column",
    (_name, table) => {
      const indexedLeading = new Set<string>();
      for (const index of table.indexes) {
        const [first] = index.config.columns;
        if (first && "name" in first && typeof first.name === "string") {
          indexedLeading.add(first.name);
        }
      }
      const [pkFirst] = table.primaryKeys[0]?.columns ?? [];
      if (pkFirst) indexedLeading.add(pkFirst.name);
      for (const column of table.columns) {
        if (column.primary) indexedLeading.add(column.name);
      }
      const unindexed = table.foreignKeys
        .map((fk) => fk.reference().columns[0]?.name ?? "")
        .filter((name) => !indexedLeading.has(name));
      expect(unindexed).toEqual([]);
    },
  );
});

describe("the append-only records", () => {
  /** A column nothing maintains is a claim the next reader trusts — see `ownedRecord` in `columns.ts`. */
  it.each([
    "tool_version",
    "working_set_change",
    "usage_ledger",
    "agent_connection",
    "build_approval",
    "acquire_trace",
  ])("%s has no updated_at", (name) => {
    const table = owned.find((candidate) => candidate.name === name);
    expect(table?.columns.map((column) => column.name)).not.toContain("updated_at");
  });
});

describe("delete behaviour", () => {
  const deleteActions = (table: PgTable) =>
    new Map(
      getTableConfig(table).foreignKeys.map((fk) => [
        fk.reference().columns[0]?.name,
        fk.onDelete ?? "no action",
      ]),
    );

  /** ADR 0007: deleting a person takes everything of theirs; nothing of theirs outlives the account. */
  it("cascades from the person to agents, connections and tools", () => {
    expect(deleteActions(schema.agent).get("person_id")).toBe("cascade");
    expect(deleteActions(schema.connection).get("person_id")).toBe("cascade");
    expect(deleteActions(schema.authoredTool).get("person_id")).toBe("cascade");
  });

  /** A tool outlives the connection it was authored against and the version pointer it once had. */
  it("nulls a tool's default connection and current version rather than deleting the tool", () => {
    expect(deleteActions(schema.authoredTool).get("default_connection_id")).toBe("set null");
    expect(deleteActions(schema.authoredTool).get("current_version_id")).toBe("set null");
  });

  /** ADR 0012: the ledger is the record; a tool or version going away must not erase what it did. */
  it("keeps a ledger line when its tool or version is deleted", () => {
    expect(deleteActions(schema.usageLedger).get("tool_id")).toBe("set null");
    expect(deleteActions(schema.usageLedger).get("version_id")).toBe("set null");
    expect(deleteActions(schema.toolVersion).get("publisher_job_id")).toBe("set null");
  });

  /** ADR 0012: an acquire job's record outlives the tool it built; its attempts and traces go with the job. */
  it("keeps an acquire job when its tool or a version is deleted, and takes attempts and traces with the job", () => {
    expect(deleteActions(schema.acquireJob).get("tool_id")).toBe("set null");
    expect(deleteActions(schema.acquireAttempt).get("version_id")).toBe("set null");
    expect(deleteActions(schema.acquireAttempt).get("job_id")).toBe("cascade");
    expect(deleteActions(schema.acquireTrace).get("job_id")).toBe("cascade");
  });
});

describe("the account table", () => {
  /** Better Auth 1.7 keys an external account by (issuer, accountId); `schema/auth.ts` says why by hand. */
  it("carries Better Auth 1.7's issuer column and the unique pair, which the CLI does not emit", () => {
    const config = getTableConfig(account);
    const issuer = config.columns.find((column) => column.name === "issuer");
    expect(issuer?.notNull).toBe(true);
    const pair = config.indexes.find(
      (index) => index.config.name === "account_issuer_accountId_uidx",
    );
    expect(pair?.config.unique).toBe(true);
    expect(pair?.config.columns.map((column) => ("name" in column ? column.name : ""))).toEqual([
      "issuer",
      "account_id",
    ]);
  });
});
