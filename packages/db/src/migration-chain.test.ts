import { describe, expect, it } from "vitest";

import { MIGRATIONS_DIR } from "./migrate";
import {
  checkMigrationChain,
  type MigrationChain,
  readMigrationChain,
  snapshotFileFor,
} from "./migration-chain";

/**
 * The migration-chain guard, against fixtures.
 *
 * The four failures this guard was written for were planted in the real tree once — a middle `.sql`
 * deleted, a middle snapshot deleted, a journal entry for a migration that does not exist, and the
 * intact tree as a control — and in each of the first three `drizzle-kit check` and `drizzle-kit
 * generate` both passed while this failed. That run is what proved the guard is not redundant, and it
 * is also gone the moment the tree is restored. These fixtures are what survives it.
 *
 * So the cases below are deliberately the same cases, plus the ones a planted run cannot easily
 * produce: a `prevId` pointing at nothing while every file is present, a fork, two roots, no root, a
 * loop. Each fails on exactly one omission from `checkMigrationChain` — checked by removing each
 * assertion in turn and confirming a test went red — because a guard's own suite is the one place
 * where a test that passes for the wrong reason is indistinguishable from no guard at all.
 */

const NO_PREVIOUS_SNAPSHOT = "00000000-0000-0000-0000-000000000000";

/**
 * Four migrations, everything present, chain continuous. Every case below starts here and breaks one
 * thing, so the control below is what pins that the fixture itself is not the reason a test is red.
 */
function intactChain(): MigrationChain {
  const tags = ["0000_first", "0001_second", "0002_third", "0003_fourth"];
  return {
    entries: tags.map((tag, idx) => ({ idx, tag })),
    sqlFiles: tags.map((tag) => `${tag}.sql`),
    snapshots: tags.map((_, idx) => ({
      file: snapshotFileFor(idx),
      id: `id-${idx}`,
      prevId: idx === 0 ? NO_PREVIOUS_SNAPSHOT : `id-${idx - 1}`,
    })),
  };
}

/** One line matching, so a case cannot pass on some *other* problem the fixture happens to have. */
function onlyProblem(chain: MigrationChain, pattern: RegExp): string {
  const problems = checkMigrationChain(chain);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(pattern);
  return problems[0] ?? "";
}

describe("checkMigrationChain", () => {
  it("finds nothing wrong with an intact chain", () => {
    expect(checkMigrationChain(intactChain())).toEqual([]);
  });

  describe("the journal against the files", () => {
    /**
     * The deploy-breaking case, and the one the whole guard is named after. The migrator reads the
     * journal and opens `${tag}.sql`; the tip snapshot is untouched, so `generate` is satisfied, and
     * nothing forked, so `check` is satisfied.
     */
    it("reports a journal entry whose .sql file is missing from the middle", () => {
      const chain = intactChain();
      chain.sqlFiles = chain.sqlFiles.filter((file) => file !== "0001_second.sql");

      onlyProblem(chain, /journal entry 1 lists "0001_second" but 0001_second\.sql is not on disk/);
    });

    it("reports a journal entry whose snapshot is missing from the middle", () => {
      const chain = intactChain();
      chain.snapshots = chain.snapshots.filter(
        (snapshot) => snapshot.file !== "0002_snapshot.json",
      );

      // Two facts, not one: the file is absent, and the chain therefore stops early. Both are worth
      // saying — the first names what to restore, the second is what a deploy would hit.
      const problems = checkMigrationChain(chain);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(
        /journal entry 2 \("0002_third"\) has no meta\/0002_snapshot\.json/,
      );
      expect(problems[1]).toMatch(/reaches meta\/0001_snapshot\.json after 2 of 3 snapshots/);
    });

    it("reports a journal entry for a migration that does not exist", () => {
      const chain = intactChain();
      chain.entries.push({ idx: 4, tag: "0004_invented" });

      const problems = checkMigrationChain(chain);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/0004_invented\.sql is not on disk/);
      expect(problems[1]).toMatch(/has no meta\/0004_snapshot\.json/);
    });

    /** The mirror image: not a crash, just a migration no deploy will ever apply. */
    it("reports a .sql file with no journal entry", () => {
      const chain = intactChain();
      chain.sqlFiles.push("0004_orphan.sql");

      onlyProblem(chain, /0004_orphan\.sql is on disk with no journal entry/);
    });

    it("reports a snapshot with no journal entry", () => {
      const chain = intactChain();
      chain.snapshots.push({ file: "0004_snapshot.json", id: "id-4", prevId: "id-3" });

      onlyProblem(chain, /meta\/0004_snapshot\.json is on disk with no journal entry/);
    });

    it("reports an entry removed from the middle of the journal", () => {
      const chain = intactChain();
      chain.entries = chain.entries.filter((entry) => entry.idx !== 1);

      // Renumbering everything after the hole is what makes this loud: the two surviving entries are
      // now at the wrong positions, and their files are orphaned rather than missing.
      const problems = checkMigrationChain(chain);
      expect(problems).toEqual([
        expect.stringMatching(/journal entry at position 1 has idx 2/),
        expect.stringMatching(/journal entry at position 2 has idx 3/),
        expect.stringMatching(/0001_second\.sql is on disk with no journal entry/),
        expect.stringMatching(/meta\/0001_snapshot\.json is on disk with no journal entry/),
      ]);
    });

    it("reports a tag whose prefix does not match its idx", () => {
      const chain = intactChain();
      chain.entries[2] = { idx: 2, tag: "0009_third" };
      chain.sqlFiles[2] = "0009_third.sql";

      onlyProblem(chain, /journal entry 2 has tag "0009_third", which does not start with "0002_"/);
    });
  });

  describe("the prevId chain", () => {
    /**
     * The case a planted-file run cannot produce and `drizzle-kit check` cannot see. Every file is
     * present and no two snapshots share a `prevId`, so nothing forks — the link simply points at a
     * snapshot that is not there.
     */
    it("reports a prevId pointing at nothing, with every file present", () => {
      const chain = intactChain();
      chain.snapshots[2] = { file: "0002_snapshot.json", id: "id-2", prevId: "id-vanished" };

      onlyProblem(
        chain,
        /reaches meta\/0001_snapshot\.json after 2 of 4 snapshots, leaving meta\/0002_snapshot\.json, meta\/0003_snapshot\.json unreachable/,
      );
    });

    /** `drizzle-kit check` catches this too. Asserted so that the overlap stays deliberate. */
    it("reports a fork as a fork rather than as a hole", () => {
      const chain = intactChain();
      chain.snapshots.push({ file: "0004_snapshot.json", id: "id-4", prevId: "id-1" });
      chain.entries.push({ idx: 4, tag: "0004_parallel" });
      chain.sqlFiles.push("0004_parallel.sql");

      // A fork stops the walk, so everything past it is unvisited — but reporting that as a hole
      // would make the two failures read identically, and only one of them is what `drizzle-kit
      // check` already covers. The fork is the cause and is reported alone.
      expect(checkMigrationChain(chain)).toEqual([
        expect.stringMatching(/the chain forks after meta\/0001_snapshot\.json/),
      ]);
    });

    it("reports a missing first snapshot as a chain with no first link", () => {
      const chain = intactChain();
      chain.snapshots[0] = { file: "0000_snapshot.json", id: "id-0", prevId: "id-earlier" };

      onlyProblem(chain, /no snapshot has prevId 0{8}-0{4}-0{4}-0{4}-0{12}/);
    });

    it("reports two snapshots both claiming to be first", () => {
      const chain = intactChain();
      chain.snapshots[2] = {
        file: "0002_snapshot.json",
        id: "id-2",
        prevId: NO_PREVIOUS_SNAPSHOT,
      };

      onlyProblem(
        chain,
        /meta\/0000_snapshot\.json, meta\/0002_snapshot\.json all claim to be the first snapshot/,
      );
    });

    it("reports two snapshots sharing an id", () => {
      const chain = intactChain();
      chain.snapshots[3] = { file: "0003_snapshot.json", id: "id-2", prevId: "id-2" };

      const problems = checkMigrationChain(chain);
      expect(problems).toContainEqual(
        expect.stringMatching(
          /meta\/0002_snapshot\.json, meta\/0003_snapshot\.json all claim id id-2/,
        ),
      );
    });

    /**
     * The walk has to terminate on adversarial input, and this is the only shape that can make it
     * loop: `prevId` is a single parent, so a cycle is unreachable from the root unless two snapshots
     * share an id and one of them is its own successor. Without the `seen` guard this hangs, which in
     * CI is a runner timeout — a guard that never finishes is a guard that never reports.
     */
    it("terminates on a chain that loops back on itself", () => {
      const chain = intactChain();
      chain.snapshots[1] = { file: "0001_snapshot.json", id: "id-0", prevId: "id-0" };

      const problems = checkMigrationChain(chain);
      expect(problems).toEqual([
        expect.stringMatching(
          /meta\/0000_snapshot\.json, meta\/0001_snapshot\.json all claim id id-0/,
        ),
        expect.stringMatching(/the chain loops back to meta\/0001_snapshot\.json/),
      ]);
    });

    it("reports the position at which the walk diverges from the file order", () => {
      const chain = intactChain();
      // 0000 → 0002 → 0001 → 0003: one root, no fork, every file present and every link resolvable,
      // so nothing else here has anything to say. Only the numbering disagrees with the chain.
      chain.snapshots[1] = { file: "0001_snapshot.json", id: "id-1", prevId: "id-2" };
      chain.snapshots[2] = { file: "0002_snapshot.json", id: "id-2", prevId: "id-0" };
      chain.snapshots[3] = { file: "0003_snapshot.json", id: "id-3", prevId: "id-1" };

      onlyProblem(
        chain,
        /reaches meta\/0002_snapshot\.json at position 1, where meta\/0001_snapshot\.json was expected/,
      );
    });
  });

  it("has nothing to say about a repo with no migrations at all", () => {
    expect(checkMigrationChain({ entries: [], sqlFiles: [], snapshots: [] })).toEqual([]);
  });
});

/**
 * The guard pointed at the real thing, so `pnpm run test` fails on a hole too and not only CI.
 *
 * Cheap enough to belong in a suite that is otherwise database-free: thirteen `JSON.parse` calls and
 * two `readdir`s, no connection and no drizzle-kit.
 */
describe("the committed migration chain", () => {
  it("is continuous", () => {
    const migrationsDir = MIGRATIONS_DIR;

    expect(checkMigrationChain(readMigrationChain(migrationsDir))).toEqual([]);
  });
});
