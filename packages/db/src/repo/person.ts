import { count } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { user } from "../schema/auth";

/**
 * The person aggregate's one read of its own (ADR 0007: the person is Better Auth's user and the
 * outermost boundary). Everything else about a person goes through Better Auth's API, which owns
 * the table; this exists for the boot, which has to know whether the database holds anybody before
 * it opens the bootstrapped admin (`apps/server/src/boot.ts`, GRA-33).
 *
 * Deliberately unscoped, and pinned by name in `scope.test.ts` beside the other two: there is no
 * person to scope a count of persons to.
 */
export async function countPersons(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ total: count() }).from(user);
  return row?.total ?? 0;
}
