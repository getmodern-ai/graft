import { insertUsage, lastUsedAtByTool, listUsage } from "@graft/db/repo/usage";

/** The ledger module's test seam. */
export type LedgerDeps = {
  insertUsage: typeof insertUsage;
  listUsage: typeof listUsage;
  lastUsedAtByTool: typeof lastUsedAtByTool;
  newId: () => string;
  now: () => Date;
};

export const defaultLedgerDeps: LedgerDeps = {
  insertUsage,
  listUsage,
  lastUsedAtByTool,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
