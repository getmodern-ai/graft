import { insertUsage, lastUsedAtByTool, listUsage, listUsageForVendor } from "@graft/db/repo/usage";

/** The ledger module's test seam. */
export type LedgerDeps = {
  insertUsage: typeof insertUsage;
  listUsage: typeof listUsage;
  /** The person-scoped read behind the console's "recent vendor calls" (GRA-26). */
  listUsageForVendor: typeof listUsageForVendor;
  lastUsedAtByTool: typeof lastUsedAtByTool;
  newId: () => string;
  now: () => Date;
};

export const defaultLedgerDeps: LedgerDeps = {
  insertUsage,
  listUsage,
  listUsageForVendor,
  lastUsedAtByTool,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
