import type { StockToolRow, StockToolVersionRow } from "@graft/db/repo/stock";

import type { StockDeps } from "../stock.deps";

/**
 * The stock catalogue over two in-memory maps, with the repo's semantics: a tool is unique by
 * `(vendor, name)`, the current version is the highest number. For `@graft/core`'s suite and
 * `@graft/mcp`'s end-to-end one (GRA-238), which seeds it through `loadStockCatalogue` as the boot
 * does. The lock is a no-op: one process, no concurrent transactions.
 */
export type FakeStockCatalogue = {
  deps: StockDeps;
  tools: Map<string, StockToolRow>;
  versions: Map<string, StockToolVersionRow>;
};

export function createFakeStockCatalogue(): FakeStockCatalogue {
  const tools = new Map<string, StockToolRow>();
  const versions = new Map<string, StockToolVersionRow>();
  let counter = 0;
  const latest = (stockToolId: string) =>
    [...versions.values()]
      .filter((row) => row.stockToolId === stockToolId)
      .sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
  const current = () =>
    [...tools.values()]
      .map((tool) => ({ tool, version: latest(tool.id) }))
      .filter(
        (row): row is { tool: StockToolRow; version: StockToolVersionRow } => row.version !== null,
      )
      .sort(
        (a, b) =>
          a.tool.vendor.localeCompare(b.tool.vendor) || a.tool.name.localeCompare(b.tool.name),
      );
  const deps: StockDeps = {
    lockStockCatalogue: async () => {},
    insertStockTool: async (_db, input) => {
      if (
        [...tools.values()].some((row) => row.vendor === input.vendor && row.name === input.name)
      ) {
        return null;
      }
      const row: StockToolRow = { ...input, createdAt: new Date() };
      tools.set(row.id, row);
      return row;
    },
    findStockTool: async (_db, key) =>
      [...tools.values()].find((row) => row.vendor === key.vendor && row.name === key.name) ?? null,
    findLatestStockToolVersion: async (_db, stockToolId) => latest(stockToolId),
    hasStockToolVersionWithHash: async (_db, stockToolId, sourceHash) =>
      [...versions.values()].some(
        (row) => row.stockToolId === stockToolId && row.sourceHash === sourceHash,
      ),
    insertStockToolVersion: async (_db, input) => {
      const row: StockToolVersionRow = { ...input, createdAt: input.createdAt ?? new Date() };
      versions.set(row.id, row);
      return row;
    },
    listCurrentStockTools: async () => current(),
    listCurrentStockToolsForVendor: async (_db, vendor) =>
      current().filter((row) => row.tool.vendor === vendor),
    findCurrentStockTool: async (_db, key) =>
      current().find((row) => row.tool.vendor === key.vendor && row.tool.name === key.name) ?? null,
    newId: () => `stock_${++counter}`,
  };
  return { deps, tools, versions };
}
