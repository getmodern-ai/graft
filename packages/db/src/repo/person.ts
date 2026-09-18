import { count, eq } from "drizzle-orm";

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
 *
 * The second write, `markPersonEmailVerified`, is the boot's too (GRA-94): registering opens no
 * session until the address is verified, and the admin the self-hosted image opens from its
 * environment was typed there by the operator — the trust the flag withholds is theirs to give, so
 * the boot gives it rather than printing a verification link nobody asked for. The integration
 * suites and the proof scripts use it for the same reason. Unscoped by nature and pinned as such:
 * it takes the address, not a person, because it runs before any person has signed in.
 */
export async function countPersons(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ total: count() }).from(user);
  return row?.total ?? 0;
}

/** Mark the person holding `email` as verified, answering whether such a person existed. */
export async function markPersonEmailVerified(db: DbOrTx, email: string): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(user.email, email))
    .returning({ id: user.id });
  return rows.length > 0;
}
