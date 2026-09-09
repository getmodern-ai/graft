import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Integrity of the migration chain: the journal, the files it names, and the `prevId` links between
 * snapshots.
 *
 * This is the third of three guards, and the reason it is separate from the other two is that they
 * answer different questions and none of the three implies another:
 *
 *   * `drizzle-kit check` → the chain does not **fork**. It looks for two snapshots claiming the same
 *     `prevId`, which is what two parallel branches produce. Verified to exit 1 on exactly that.
 *   * `drizzle-kit generate` producing nothing → the TypeScript schema matches the **tip** snapshot.
 *   * this → every journal entry has its `.sql` and its `NNNN_snapshot.json`, nothing is on disk
 *     without a journal entry, and the `prevId` chain is **continuous** from the first snapshot to
 *     the tip.
 *
 * Fork-free is not gap-free, and that gap is the whole reason this file exists. A journal entry whose
 * `.sql` file is absent passes `drizzle-kit check`; so does a snapshot missing from the middle of the
 * sequence, and so does a `prevId` pointing at a snapshot that is not there. `generate` is satisfied
 * too, because it diffs against the tip, and the tip is intact in all three cases. So the combination
 * is green in CI and fails at deploy — where the migration step gates the rollout, which means a hole
 * stops a deploy rather than a build. All four cases were planted and confirmed against the real tree
 * before this was written; see `migration-chain.test.ts` for the same cases as fixtures.
 *
 * No database, no credentials and no drizzle-kit: this is a filesystem-and-journal comparison, so it
 * costs milliseconds and runs anywhere.
 */

/** drizzle's sentinel `prevId` for the snapshot that has no predecessor. */
const NO_PREVIOUS_SNAPSHOT = "00000000-0000-0000-0000-000000000000";

/** `0007_snapshot.json` — the only files under `meta/` this check owns. `_journal.json` is not one. */
const SNAPSHOT_FILE = /^\d{4}_snapshot\.json$/;

export type JournalEntry = {
  idx: number;
  tag: string;
};

/**
 * The parts of a snapshot the chain is made of. The rest of the file is the schema at that point,
 * which `drizzle-kit generate` is responsible for and this is not.
 */
export type Snapshot = {
  /** Basename, e.g. `0007_snapshot.json`. Used in every message, since it is what a reader can find. */
  file: string;
  id: string;
  prevId: string;
};

export type MigrationChain = {
  entries: JournalEntry[];
  /** Every `*.sql` basename in the migrations folder, sorted. */
  sqlFiles: string[];
  /** Every `NNNN_snapshot.json` under `meta/`, parsed, sorted by filename. */
  snapshots: Snapshot[];
};

/** The snapshot drizzle writes alongside journal entry `idx`. */
export function snapshotFileFor(idx: number): string {
  return `${String(idx).padStart(4, "0")}_snapshot.json`;
}

/**
 * Every problem found, as lines a human can act on. Empty means the chain is intact.
 *
 * Returns a list rather than throwing on the first, because these defects arrive together — a
 * half-committed migration is missing its `.sql` *and* its snapshot *and* breaks the chain — and
 * seeing all of it at once is what tells you which of those it is.
 */
export function checkMigrationChain({ entries, sqlFiles, snapshots }: MigrationChain): string[] {
  return [
    ...checkJournalAgainstFiles(entries, sqlFiles, snapshots),
    ...checkPrevIdChain(snapshots),
  ];
}

/**
 * The correspondence, asserted in **both** directions.
 *
 * Journal → disk is the one that catches a deploy failure: the migrator reads `entries` and opens
 * `${tag}.sql`, so an entry without its file is a crash in production and nowhere earlier. Disk →
 * journal catches the mirror image, a migration that no deploy will ever run — which is silent
 * forever rather than loud once, and therefore worse.
 */
function checkJournalAgainstFiles(
  entries: JournalEntry[],
  sqlFiles: string[],
  snapshots: Snapshot[],
): string[] {
  const problems: string[] = [];
  const onDiskSql = new Set(sqlFiles);
  const onDiskSnapshots = new Set(snapshots.map((snapshot) => snapshot.file));
  const expectedSql = new Set<string>();
  const expectedSnapshots = new Set<string>();

  entries.forEach((entry, position) => {
    // `idx` is the chain's position and drizzle derives the next one from the journal's length, so
    // the sequence has to be 0..n-1 with nothing skipped. An entry deleted from the middle shows up
    // here first, before any file is even looked at.
    if (entry.idx !== position) {
      problems.push(
        `journal entry at position ${position} has idx ${entry.idx}: entries must be numbered 0..n-1 in order, so this is an entry removed from or inserted into the middle`,
      );
    }

    // The tag's prefix is what ties an entry to its snapshot filename, so a mismatch would make
    // every check below look for the wrong file.
    const prefix = String(entry.idx).padStart(4, "0");
    if (!entry.tag.startsWith(`${prefix}_`)) {
      problems.push(
        `journal entry ${entry.idx} has tag "${entry.tag}", which does not start with "${prefix}_"`,
      );
    }

    const sqlFile = `${entry.tag}.sql`;
    expectedSql.add(sqlFile);
    if (!onDiskSql.has(sqlFile)) {
      problems.push(
        `journal entry ${entry.idx} lists "${entry.tag}" but ${sqlFile} is not on disk: every deploy that has not already applied it will fail on this`,
      );
    }

    const snapshotFile = snapshotFileFor(entry.idx);
    expectedSnapshots.add(snapshotFile);
    if (!onDiskSnapshots.has(snapshotFile)) {
      problems.push(`journal entry ${entry.idx} ("${entry.tag}") has no meta/${snapshotFile}`);
    }
  });

  for (const file of sqlFiles) {
    if (!expectedSql.has(file)) {
      problems.push(`${file} is on disk with no journal entry, so no deploy will ever apply it`);
    }
  }

  for (const snapshot of snapshots) {
    if (!expectedSnapshots.has(snapshot.file)) {
      problems.push(`meta/${snapshot.file} is on disk with no journal entry`);
    }
  }

  return problems;
}

/**
 * The walk. Start at the snapshot that claims no predecessor, follow `prevId` forward, and require
 * that it visits every snapshot in ascending file order.
 *
 * Not the same as comparing each snapshot's `prevId` to the previous file's `id` in a loop, even
 * though on an intact chain the two agree. The walk is what distinguishes the two ways a chain can be
 * wrong: it *stops early* on a hole and it *branches* on a fork, and the messages below name which.
 */
function checkPrevIdChain(snapshots: Snapshot[]): string[] {
  if (snapshots.length === 0) return [];

  const problems: string[] = [];
  const byId = new Map<string, Snapshot[]>();
  const byPrevId = new Map<string, Snapshot[]>();
  for (const snapshot of snapshots) {
    group(byId, snapshot.id, snapshot);
    group(byPrevId, snapshot.prevId, snapshot);
  }

  // Two snapshots with one id would make the walk ambiguous, so this is reported before it is
  // followed rather than as a confusing symptom of it.
  for (const [id, sharing] of byId) {
    if (sharing.length > 1) problems.push(`${name(sharing)} all claim id ${id}`);
  }

  const roots = byPrevId.get(NO_PREVIOUS_SNAPSHOT) ?? [];
  const root = roots[0];
  if (roots.length !== 1 || !root) {
    problems.push(
      roots.length === 0
        ? `no snapshot has prevId ${NO_PREVIOUS_SNAPSHOT}, so the chain has no first link: the earliest snapshot is gone`
        : `${name(roots)} all claim to be the first snapshot`,
    );
    // Nowhere to walk from, and every later message would only restate that.
    return problems;
  }

  const visited: Snapshot[] = [];
  const seen = new Set<string>();
  // Whether the walk stopped because it could not continue safely, rather than because it ran out of
  // successors. The distinction decides whether the snapshots it never reached are a finding of their
  // own or merely a consequence of the finding already reported.
  let aborted = false;
  let current: Snapshot | undefined = root;
  while (current) {
    if (seen.has(current.id)) {
      problems.push(`the chain loops back to meta/${current.file}`);
      aborted = true;
      break;
    }
    seen.add(current.id);
    visited.push(current);

    // Annotated because `current` is reassigned from this on the loop's last line, and without it
    // TypeScript reports the inference as circular (TS7022).
    const next: Snapshot[] = byPrevId.get(current.id) ?? [];
    if (next.length > 1) {
      // `drizzle-kit check` also catches this one. Kept because a fork found here is free, and
      // because stopping the walk without saying why would otherwise read as a hole.
      problems.push(
        `${name(next)} all have prevId ${current.id}: the chain forks after meta/${current.file}`,
      );
      aborted = true;
      break;
    }
    current = next[0];
  }

  // Ascending file order, so the numbering still describes the chain. Only the first mismatch is
  // reported: after one snapshot is out of place every later position is too, and the cascade says
  // nothing the first line did not.
  const ascending = snapshots.map((snapshot) => snapshot.file).sort();
  for (const [position, snapshot] of visited.entries()) {
    const expected = ascending[position];
    if (expected && snapshot.file !== expected) {
      problems.push(
        `following prevId reaches meta/${snapshot.file} at position ${position}, where meta/${expected} was expected: the chain's order and the snapshots' numbering disagree`,
      );
      break;
    }
  }

  // Only when the walk ran out of successors. A fork stops the walk too, and everything past it would
  // then be reported as unreachable — which reads as a hole, is not one, and would make the two
  // failures indistinguishable in the output. The fork above is the cause; fix it and this runs again.
  const unreachable = aborted ? [] : snapshots.filter((snapshot) => !seen.has(snapshot.id));
  if (unreachable.length > 0) {
    problems.push(
      `following prevId from meta/${root.file} reaches meta/${visited.at(-1)?.file} after ${visited.length} of ${snapshots.length} snapshots, leaving ${name(unreachable)} unreachable: the chain has a hole, which is not a fork and is not what \`drizzle-kit check\` looks for`,
    );
  }

  return problems;
}

function group<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function name(snapshots: Snapshot[]): string {
  return snapshots.map((snapshot) => `meta/${snapshot.file}`).join(", ");
}

/**
 * Reads the chain off disk.
 *
 * Sorted, both lists, so the messages come out in the same order on every machine — `readdirSync`
 * makes no ordering promise.
 *
 * Shape is validated here rather than trusted, because the failure this guard exists to catch is a
 * half-written chain and a malformed `_journal.json` is one of its forms. Left as a thrown error
 * instead of a returned problem: it means the files cannot be compared at all, which is a different
 * report from "compared, and here is what is wrong".
 */
export function readMigrationChain(migrationsDir: string): MigrationChain {
  const metaDir = join(migrationsDir, "meta");
  const journalPath = join(metaDir, "_journal.json");
  const journal: unknown = JSON.parse(readFileSync(journalPath, "utf8"));

  if (!isRecord(journal) || !Array.isArray(journal.entries)) {
    throw new Error(`${journalPath} has no "entries" array`);
  }
  const entries = journal.entries.map((entry: unknown, position: number): JournalEntry => {
    if (!isRecord(entry) || typeof entry.idx !== "number" || typeof entry.tag !== "string") {
      throw new Error(
        `${journalPath} entry at position ${position} has no numeric idx and string tag`,
      );
    }
    return { idx: entry.idx, tag: entry.tag };
  });

  const sqlFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const snapshots = readdirSync(metaDir)
    .filter((file) => SNAPSHOT_FILE.test(file))
    .sort()
    .map((file): Snapshot => {
      const snapshotPath = join(metaDir, file);
      const snapshot: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"));
      if (
        !isRecord(snapshot) ||
        typeof snapshot.id !== "string" ||
        typeof snapshot.prevId !== "string"
      ) {
        throw new Error(`${snapshotPath} has no string id and prevId`);
      }
      return { file, id: snapshot.id, prevId: snapshot.prevId };
    });

  return { entries, sqlFiles, snapshots };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
