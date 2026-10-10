import {
  defaultStockDeps,
  describeStockTool,
  listStockCatalogue,
  type StockDeps,
  type StockToolView,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import { type CopyStockDeps, copyStockVersion } from "@graft/publish";

/**
 * The **tool source** seam (ADR 0025; CONTEXT.md, *Tool source*; GRA-238): where stock tools come
 * from, as the MCP server sees it. Three verbs: list the catalogue (what `find_tool` searches
 * beside the toolbox), describe one stock tool by its key, and copy a stock version into a
 * person's toolbox (what the first `run_tool` or `promote` of one does, through `stock-copy.ts`).
 * There is no run path here: a copy runs as any authored tool does (`run.ts`). Graft's own stock
 * is the one backing (`createStockToolSource`); a later source whose tools run elsewhere brings
 * its own run path then.
 */
export type ToolSource = {
  /** Every stock tool at its current version. */
  list(): Promise<StockToolView[]>;
  /** One stock tool at its current version, or null when the catalogue has none of that key. */
  describe(key: { vendor: string; name: string }): Promise<StockToolView | null>;
  /**
   * The stock tool's version written into the person's toolbox as an ordinary tool and version
   * recording its stock origin; the person's own tool of that name is answered untouched instead.
   */
  copy(args: {
    personId: string;
    /** The agent whose call made the copy, for the mirror's event. */
    agentId?: string | null;
    stock: StockToolView;
    defaultConnectionId: string | null;
  }): Promise<AuthoredToolRow>;
};

/** Graft's own stock: the global catalogue's rows, and `@graft/publish`'s copy into the toolbox. */
export function createStockToolSource(args: {
  db: DbOrTx;
  /** The publish's rows (with the per-name lock), store and mirror. */
  publish: CopyStockDeps;
  stock?: StockDeps;
}): ToolSource {
  const ctx = { db: args.db };
  const stock = args.stock ?? defaultStockDeps;
  return {
    list: () => listStockCatalogue(ctx, stock),
    describe: (key) => describeStockTool(ctx, key, stock),
    copy: (copy) => copyStockVersion(args.publish, copy),
  };
}
