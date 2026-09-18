import type { MigrationChain } from "@graft/db/migration-chain";

/**
 * What the self-hosted image does between a valid environment and a listening port (GRA-33): apply
 * the committed migrations, then open the one admin a fresh database starts with. Both are functions
 * of what they are handed, like `createServer`, so `boot.test.ts` drives them with fakes and
 * `index.ts` binds the real chain, the real migrator and Better Auth.
 */

/** The chain is broken — a hole `drizzle-kit check` cannot see (`@graft/db`'s `migration-chain.ts`). */
export class MigrationChainBrokenError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `the migration chain is broken in ${problems.length} way(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "MigrationChainBrokenError";
  }
}

export type MigrateOnStartDeps = {
  /** The committed chain as files — `readMigrationChain(MIGRATIONS_DIR)`. */
  readChain: () => MigrationChain;
  /** The hole check — `checkMigrationChain`. */
  checkChain: (chain: MigrationChain) => string[];
  /** drizzle's migrator over the process's handle — `applyMigrations(db)`. */
  apply: () => Promise<void>;
  log: (line: string) => void;
};

/**
 * Apply every migration the database has not seen, refusing first if the chain has a hole. The
 * check comes before the migrator because the migrator's own failure on a hole is a stack trace
 * about a missing file half-way through, after the entries before it have been applied; the check
 * says what is wrong and applies nothing. Idempotent: drizzle records what it applied in
 * `__drizzle_migrations`, so a second start over the same database does nothing and says so.
 */
export async function migrateOnStart(deps: MigrateOnStartDeps): Promise<{ migrations: number }> {
  const chain = deps.readChain();
  const problems = deps.checkChain(chain);
  if (problems.length > 0) throw new MigrationChainBrokenError(problems);

  await deps.apply();
  const tip = chain.entries.at(-1)?.tag ?? "(none)";
  deps.log(`migrations: the chain of ${chain.entries.length} is applied, through ${tip}`);
  return { migrations: chain.entries.length };
}

export type AdminCredentials = { email: string; password: string };

export type AdminBootstrapDeps = {
  /** How many persons the database holds — `countPersons(db)`, unscoped by nature. */
  countPersons: () => Promise<number>;
  /**
   * Better Auth's own sign-up, so the row is the library's and not a hand-written insert — and,
   * since registering opens no session until the address is verified (GRA-94), the mark that makes
   * this one verified: the operator typed the address, and a first boot has nowhere to send a link.
   */
  signUp: (input: AdminCredentials & { name: string }) => Promise<void>;
  log: (line: string) => void;
};

export type AdminBootstrapOutcome = "created" | "skipped: persons exist" | "skipped: unconfigured";

/** The display name the account opens with; the person renames it in the console if they care to. */
export const ADMIN_NAME = "Admin";

/**
 * Open the bootstrapped admin, and only into an empty database. The variables are read on every
 * start but act once: a database that already holds a person — this admin, or anyone — is never
 * touched, so a changed `GRAFT_ADMIN_PASSWORD` resets nothing, and the boot line says so rather than
 * leaving the operator to wonder. Unconfigured is the laptop's normal state and is silent.
 */
export async function bootstrapAdmin(
  admin: AdminCredentials | null,
  deps: AdminBootstrapDeps,
): Promise<AdminBootstrapOutcome> {
  if (admin === null) return "skipped: unconfigured";

  const persons = await deps.countPersons();
  if (persons > 0) {
    deps.log(
      `admin bootstrap skipped: the database already holds ${persons} person(s) — GRAFT_ADMIN_EMAIL and GRAFT_ADMIN_PASSWORD act only on an empty database`,
    );
    return "skipped: persons exist";
  }

  await deps.signUp({ ...admin, name: ADMIN_NAME });
  deps.log(
    `admin ${admin.email} created from GRAFT_ADMIN_EMAIL — sign in at the console with GRAFT_ADMIN_PASSWORD`,
  );
  return "created";
}
