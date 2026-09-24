import { drizzle } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it } from "vitest";

import type { DbOrTx } from "../index";
import { countSetupWork, findSetup, lockSetup, saveSetup } from "./setup";

/**
 * **The person is in every statement** of the Setup record's repo (ADR 0007, ADR 0024), pinned as
 * `scope.test.ts` pins the rest: rendered by a fake `pg` client that records what drizzle would
 * send, so what is asserted is the predicate. The record's key is the person, so a read or a
 * write for one person can only ever reach that person's row, and the count the show rule reads
 * names the person in both subqueries.
 */

let statements: { sql: string; params: readonly unknown[] }[] = [];

const db = drizzle({
  client: {
    query: async (config: { text?: string }, params: readonly unknown[] = []) => {
      statements.push({ sql: config.text ?? "", params });
      // `lockSetup` and `saveSetup` refuse an answer with no row, as a real one never is.
      return {
        rows: config.text?.startsWith("select") || config.text?.includes("returning") ? [{}] : [],
        rowCount: 1,
        fields: [],
        command: "",
        oid: 0,
      };
    },
  } as never,
}) as unknown as DbOrTx;

beforeEach(() => {
  statements = [];
});

describe("the setup record's statements name the person", () => {
  it("reads the record by the person", async () => {
    await findSetup(db, "person_1");
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/from "setup" where "setup"\."person_id" = \$1 limit \$2$/);
    expect(statements[0]?.params).toEqual(["person_1", 1]);
  });

  it("locks it by the person, making it first when absent", async () => {
    await lockSetup(db, "person_1");
    expect(statements).toHaveLength(2);
    const [insert, select] = statements;
    expect(insert?.sql).toMatch(/^insert into "setup" \("person_id", /);
    expect(insert?.sql).toContain('on conflict ("person_id") do nothing');
    expect(insert?.params[0]).toBe("person_1");
    expect(select?.sql).toMatch(/where "setup"\."person_id" = \$1 limit \$2 for update$/);
    expect(select?.params).toEqual(["person_1", 1]);
  });

  it("writes it on the person's key, setting only the patch's columns on a conflict", async () => {
    const at = new Date("2026-09-23T10:00:00Z");
    await saveSetup(db, "person_1", { skippedAt: at });
    expect(statements).toHaveLength(1);
    const s = statements[0];
    expect(s?.sql).toContain('on conflict ("person_id") do update set "skipped_at" = $');
    expect(s?.sql).toMatch(/set "skipped_at" = \$\d+, "updated_at" = \$\d+ returning/);
    expect(s?.params).toContain("person_1");
  });

  it("counts the person's connections and tools, each subquery under the person", async () => {
    await countSetupWork(db, "person_1");
    expect(statements).toHaveLength(1);
    const s = statements[0];
    expect(s?.sql).toContain(
      '(select count(*) from "connection" where "connection"."person_id" = $1)',
    );
    expect(s?.sql).toContain(
      '(select count(*) from "authored_tool" where "authored_tool"."person_id" = $2)',
    );
    expect(s?.sql).toMatch(/from "user" where "user"\."id" = \$3 limit \$4$/);
    expect(s?.params).toEqual(["person_1", "person_1", "person_1", 1]);
  });
});
