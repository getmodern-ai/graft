import type { DbOrTx } from "@graft/db";

/**
 * What every service is handed first: the database handle, plain or inside a caller's transaction.
 * No session and no agent — who is asking is resolved *before* a service is called (`tenancy.ts`)
 * and passed as a `Principal` or an `AgentScope`, so a service cannot forget to check and a test
 * never has to fake a cookie.
 */
export type ServiceContext = { db: DbOrTx };
