import {
  createTool,
  publishToolVersion as recordPublishedVersion,
  type ServiceContext,
  ServiceError,
  type StockToolView,
} from "@graft/core";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import { toolboxIdOf, versionPath as versionPathOf } from "@graft/toolbox";

import { sourceHashOf } from "./hash";
import { normaliseManifest } from "./manifest";
import type { PublishDeps } from "./publish.service";

/**
 * The copy of a stock tool into a person's toolbox (ADR 0025, "copied into the person's toolbox the
 * first time it is reached for"; GRA-238): what the first `run_tool` or `promote` of a stock tool
 * does, through `@graft/mcp`'s tool source. The stock version's files are written as version 1 of
 * the tool's directory exactly as a publish writes one (`normaliseManifest`), then the rows: an
 * ordinary `authored_tool` of the same `<vendor>__<name>` and a `tool_version` carrying the stock
 * origin (`stockToolId`, `stockVersionId`), the definition and the pointer moved in the publish's
 * one transaction. From there the working set, the approvals, the ledger, the mount and the sweep
 * see an authored tool and nothing else.
 *
 * No check, no install, no dry run: the catalogue's version was checked when it was appended
 * (`@graft/core`'s `loadStockCatalogue`) and its result is the version's `checkOutput`, and a stock
 * module declares no package (`@graft/stock`'s harness). The pointer names a version no dry run
 * passed in this toolbox; the stock harness proved it before it shipped, which is the dry run's
 * purpose (ADR 0012), and a write still stops at the approval gate on its first call (ADR 0008).
 *
 * **A person's own tool of the name is answered as it is** (the shadow rule): nothing is written,
 * so a copy made by a second call racing the first, or a tool the person authored before stock
 * existed, is never overwritten. Two copies racing both write the same files to `v1`; the second's
 * insert is refused as a conflict and it answers the first's row.
 */
export async function copyStockVersion(
  deps: Pick<PublishDeps, "db" | "store" | "tool">,
  args: { personId: string; stock: StockToolView; defaultConnectionId: string | null },
): Promise<AuthoredToolRow> {
  const { stock, personId } = args;
  const key = { vendor: stock.vendor, name: stock.name };
  const existing = await deps.tool.findAuthoredTool(deps.db, personId, key);
  if (existing) return existing;

  const versionPath = versionPathOf(stock.vendor, stock.name, 1);
  const written = normaliseManifest(stock.files);
  await deps.store.writeTree(toolboxIdOf(personId), versionPath, written);

  const ctx: ServiceContext = { db: deps.db };
  const principal = { personId };
  const definition = {
    description: stock.description,
    inputSchema: stock.inputSchema,
    annotations: stock.annotations,
    defaultConnectionId: args.defaultConnectionId,
  };
  try {
    const recorded = await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
      const tool = await createTool(scoped, principal, { ...key, ...definition }, deps.tool);
      return recordPublishedVersion(
        scoped,
        principal,
        tool.id,
        {
          path: versionPath,
          sourceHash: sourceHashOf(written),
          checkOutput: stock.checkOutput,
          writesInvolved: !stock.annotations.readOnly,
          stockToolId: stock.stockToolId,
          stockVersionId: stock.stockVersionId,
        },
        definition,
        deps.tool,
      );
    });
    return recorded.tool;
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== "CONFLICT") throw error;
    const raced = await deps.tool.findAuthoredTool(deps.db, personId, key);
    if (!raced) throw error;
    return raced;
  }
}
