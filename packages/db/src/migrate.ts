import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Database } from "./index";

/**
 * Where drizzle-kit writes the chain (`drizzle.config.ts`'s `out`), resolved from this file rather
 * than from `process.cwd()` so it is the same directory whichever workspace the caller runs in.
 * `check-migration-chain.ts` reads it; `applyMigrations` replays it.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/", import.meta.url));

/**
 * Apply every migration the journal lists that the database has not seen — drizzle-orm's runtime
 * migrator, which is what a deployment runs at boot and what the integration suite runs against an
 * empty database. `drizzle-kit migrate` does the same from the CLI with `apps/server/.env`; this
 * exists for the callers that hold a handle and no `.env`.
 */
export async function applyMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
