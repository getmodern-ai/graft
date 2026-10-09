/**
 * The **advance rule** of ADR 0025 as a pure function (GRA-242): whether a person's tool follows
 * the stock catalogue, and whether it moves now. Browser-safe, imports nothing, so the console reads
 * the same lineage the server decides on.
 *
 * - **Lineage** is read off the tool's versions alone: `stock` when every version carries a stock
 *   origin (a copy no agent has published on), `remix` once any version does not (the agent published
 *   on the copy, `acquire` with `from`), `authored` when none does (the agent's own tool, a stock
 *   tool's name or not). A remix stays a remix: a stock version above an agent's does not undo it.
 * - **Advance** only an untouched copy, only to the catalogue's current version, and only when the
 *   copy never took that version. The catalogue is append-only and its current version is its
 *   highest, so a current version the copy never took is newer than every version the copy did.
 *   Several stock versions passed at once are one advance, to the current.
 *
 * The callers apply what this returns: `@graft/publish`'s `advanceStockCopy` under the tool row's
 * lock, so two reaches at once decide the second time over the first's version and stay.
 */

/** One version of a person's tool, by where it came from. Null on a version the agent published. */
export type VersionOrigin = { stockToolId: string | null; stockVersionId: string | null };

export type StockLineage = "stock" | "remix" | "authored";

/** The catalogue's current version of the stock tool of the copy's `<vendor>__<name>`. */
export type CatalogueCurrent = {
  stockToolId: string;
  stockVersionId: string;
  versionNumber: number;
};

export type StockAdvanceDecision =
  | {
      action: "advance";
      stockToolId: string;
      stockVersionId: string;
      stockVersionNumber: number;
    }
  | {
      action: "stay";
      reason: "current" | "remix" | "authored" | "not_in_catalogue" | "other_stock_tool";
    };

export function stockLineageOf(versions: readonly VersionOrigin[]): StockLineage {
  const fromStock = versions.filter((version) => version.stockToolId !== null).length;
  if (fromStock === 0) return "authored";
  return fromStock === versions.length ? "stock" : "remix";
}

export function decideStockAdvance(input: {
  versions: readonly VersionOrigin[];
  catalogue: CatalogueCurrent | null;
}): StockAdvanceDecision {
  const lineage = stockLineageOf(input.versions);
  if (lineage !== "stock") return { action: "stay", reason: lineage };
  const { catalogue } = input;
  if (!catalogue) return { action: "stay", reason: "not_in_catalogue" };
  if (input.versions.some((version) => version.stockToolId !== catalogue.stockToolId)) {
    return { action: "stay", reason: "other_stock_tool" };
  }
  if (input.versions.some((version) => version.stockVersionId === catalogue.stockVersionId)) {
    return { action: "stay", reason: "current" };
  }
  return {
    action: "advance",
    stockToolId: catalogue.stockToolId,
    stockVersionId: catalogue.stockVersionId,
    stockVersionNumber: catalogue.versionNumber,
  };
}
