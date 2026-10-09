import {
  findCurrentStockTool,
  findLatestStockToolVersion,
  findStockTool,
  hasStockToolVersionWithHash,
  insertStockTool,
  insertStockToolVersion,
  listCurrentStockTools,
  listCurrentStockToolsForVendor,
  lockStockCatalogue,
} from "@graft/db/repo/stock";

/** The stock catalogue's test seam (ADR 0025; GRA-238): the global rows, an id and the lock. */
export type StockDeps = {
  lockStockCatalogue: typeof lockStockCatalogue;
  insertStockTool: typeof insertStockTool;
  findStockTool: typeof findStockTool;
  findLatestStockToolVersion: typeof findLatestStockToolVersion;
  hasStockToolVersionWithHash: typeof hasStockToolVersionWithHash;
  insertStockToolVersion: typeof insertStockToolVersion;
  listCurrentStockTools: typeof listCurrentStockTools;
  listCurrentStockToolsForVendor: typeof listCurrentStockToolsForVendor;
  findCurrentStockTool: typeof findCurrentStockTool;
  newId: () => string;
};

export const defaultStockDeps: StockDeps = {
  lockStockCatalogue,
  insertStockTool,
  findStockTool,
  findLatestStockToolVersion,
  hasStockToolVersionWithHash,
  insertStockToolVersion,
  listCurrentStockTools,
  listCurrentStockToolsForVendor,
  findCurrentStockTool,
  newId: () => crypto.randomUUID(),
};
