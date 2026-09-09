import { MIGRATIONS_DIR } from "./migrate";
import { checkMigrationChain, readMigrationChain } from "./migration-chain";

/**
 * CLI over `migration-chain.ts` — `pnpm run db:check-chain`, from this package or from the root.
 *
 * A separate file from the checker so that importing the checker has no side effects: the suite in
 * `migration-chain.test.ts` imports it, and a module that read the real directory and called
 * `process.exit` on import would take the test run with it.
 */
const chain = readMigrationChain(MIGRATIONS_DIR);
const problems = checkMigrationChain(chain);

if (problems.length > 0) {
  console.error(`The migration chain is broken in ${problems.length} way(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nA hole here passes `drizzle-kit check` and `drizzle-kit generate` and fails when the migrations are applied.",
  );
  process.exit(1);
}

const tip = chain.snapshots.at(-1)?.file ?? "(none)";
console.log(
  `${chain.entries.length} migration(s), each with its .sql and its snapshot; the prevId chain is continuous through to meta/${tip}.`,
);
