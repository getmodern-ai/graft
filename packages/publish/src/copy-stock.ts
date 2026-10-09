import {
  annotationsWiden,
  createTool,
  decideStockAdvance,
  isUniqueViolation,
  listToolVersionOrigins,
  publishToolVersion as recordPublishedVersion,
  type ServiceContext,
  ServiceError,
  type StockToolView,
  type ToolAnnotations,
} from "@graft/core";
import type { AuthoredToolRow, ToolVersionRow } from "@graft/db/repo/tool";
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

/** What an advance did: the tool as it stands, and the stock version it now names when it moved. */
export type StockAdvance =
  | {
      advanced: true;
      tool: AuthoredToolRow;
      /** The version the advance wrote, carrying its stock origin. */
      version: ToolVersionRow;
      /** The tool's annotations before the advance: what an approval held across it was given for. */
      previous: ToolAnnotations;
      stockVersionNumber: number;
    }
  | { advanced: false; tool: AuthoredToolRow };

/**
 * **An untouched copy follows stock** (ADR 0025; GRA-242): when the catalogue's current version of
 * the stock tool is one the copy never took, it is written as the tool's next version, recording
 * its stock origin, and the pointer moves onto it with the definition, as the first copy wrote
 * version 1. A remix, an authored tool and a copy already current are answered untouched
 * (`@graft/core`'s `decideStockAdvance`).
 *
 * **Under the tool row's lock.** The whole step is one transaction that first locks the tool
 * (`findAuthoredToolForUpdate`) and only then reads the versions and decides, so two reaches of one
 * copy at once serialise: the second waits, reads the version the first wrote, and stays. The
 * version's directory is written inside the lock for the same reason. A version the agent
 * publishes at the same moment (a remix), which takes no lock, is caught by the version number's
 * unique constraint, and the advance answers the tool as the remix left it.
 *
 * The connection a copy was bound to is kept: an advance changes the code and the definition,
 * never the binding. **An approval holds across the advance unless the annotations widen** (ADR
 * 0008 as amended 2026-10-09; GRA-245): every agent's answer given for the version the copy stood
 * on is carried onto the new one in the same transaction; a widening carries nothing, so the next
 * call of a write asks again.
 */
export async function advanceStockCopy(
  deps: Pick<PublishDeps, "db" | "store" | "tool">,
  args: { personId: string; toolId: string; stock: StockToolView },
): Promise<StockAdvance> {
  const { stock, personId } = args;
  const principal = { personId };
  const ctx: ServiceContext = { db: deps.db };
  try {
    return await ctx.db.transaction(async (tx): Promise<StockAdvance> => {
      const scoped: ServiceContext = { db: tx };
      const tool = await deps.tool.findAuthoredToolForUpdate(tx, personId, args.toolId);
      if (!tool) throw new ServiceError("NOT_FOUND", "Tool not found");
      const origins = await listToolVersionOrigins(scoped, principal, deps.tool, tool.id);
      const decision = decideStockAdvance({
        versions: origins,
        catalogue: {
          stockToolId: stock.stockToolId,
          stockVersionId: stock.stockVersionId,
          versionNumber: stock.versionNumber,
        },
      });
      if (decision.action === "stay") return { advanced: false, tool };

      const versionNumber = Math.max(0, ...origins.map((origin) => origin.versionNumber)) + 1;
      const versionPath = versionPathOf(tool.vendor, tool.name, versionNumber);
      const written = normaliseManifest(stock.files);
      await deps.store.writeTree(toolboxIdOf(personId), versionPath, written);
      const previous = { readOnly: tool.readOnly, destructive: tool.destructive };
      const previousVersionId = tool.currentVersionId;
      const recorded = await recordPublishedVersion(
        scoped,
        principal,
        tool.id,
        {
          path: versionPath,
          sourceHash: sourceHashOf(written),
          checkOutput: stock.checkOutput,
          writesInvolved: !stock.annotations.readOnly,
          stockToolId: decision.stockToolId,
          stockVersionId: decision.stockVersionId,
        },
        {
          description: stock.description,
          inputSchema: stock.inputSchema,
          annotations: stock.annotations,
        },
        deps.tool,
      );
      // ADR 0008 as amended 2026-10-09 (GRA-245): the code was reviewed before release, so an
      // answer given for the version the copy stood on holds for the new one unless the new one
      // widens what was answered. Widened, the answers stay on the old version and the next call asks.
      if (previousVersionId && !annotationsWiden(previous, stock.annotations)) {
        await deps.tool.carryApprovalsToVersion(tx, personId, {
          toolId: tool.id,
          fromVersionId: previousVersionId,
          toVersionId: recorded.version.id,
        });
      }
      return {
        advanced: true,
        tool: recorded.tool,
        version: recorded.version,
        previous,
        stockVersionNumber: decision.stockVersionNumber,
      };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await deps.tool.findAuthoredToolById(deps.db, personId, args.toolId);
    if (!raced) throw error;
    return { advanced: false, tool: raced };
  }
}
