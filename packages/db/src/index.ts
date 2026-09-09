import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * `@graft/db` — the schema, the repositories and the handle. This package reads no environment:
 * `apps/server` hands `createDb` the URL it validated, so the package can be imported by a script,
 * a test or a second process without one, and a handle exists only where something asked for it.
 *
 * `pg` is the driver both drizzle and Better Auth's adapter ride; one `Pool` per process, opened
 * lazily on the first query, and `close` is how a short-lived caller — the migration test, a
 * script — lets the process exit.
 */
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return Object.assign(db, { close: () => pool.end() });
}

export type Database = ReturnType<typeof createDb>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * What a repository function takes, and what a service carries as `ctx.db`: the plain handle or a
 * transaction, so the same function runs standalone or inside a caller's transaction.
 */
export type DbOrTx = Database | Transaction;
