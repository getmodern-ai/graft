import {
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
import { toolboxIdOf, writePath } from "@graft/toolbox";

import { sourceHashOf } from "./hash";
import { normaliseManifest } from "./manifest";
import { newWriteId, type PublishDeps, startMirror } from "./publish.service";

/** What a copy needs: the publish's rows (with the per-name lock), store and mirror. */
export type CopyStockDeps = Pick<
  PublishDeps,
  "db" | "store" | "tool" | "mirror" | "onMirror" | "now" | "writeId"
>;

/**
 * The copy of a stock tool into a person's toolbox (ADR 0025, "copied into the person's toolbox the
 * first time it is reached for"; GRA-238): what the first `run_tool` or `promote` of a stock tool
 * does, through `@graft/mcp`'s tool source. The stock version's files are written to a version
 * directory of the copy's own (`@graft/toolbox`'s `writePath`) exactly as a publish writes one
 * (`normaliseManifest`), then the rows, version 1: an
 * ordinary `authored_tool` of the same `<vendor>__<name>` and a `tool_version` carrying the stock
 * origin (`stockToolId`, `stockVersionId`), the definition and the pointer moved in the publish's
 * one transaction. From there the working set, the approvals, the ledger, the mount and the sweep
 * see an authored tool and nothing else. Once committed, the mirror is asked for the version as a
 * publish asks it (step 9), off the path.
 *
 * No check, no install, no dry run: the catalogue's version was checked when it was appended
 * (`@graft/core`'s `loadStockCatalogue`) and its result is the version's `checkOutput`, and a stock
 * module declares no package (`@graft/stock`'s harness). The pointer names a version no dry run
 * passed in this toolbox; the stock harness proved it before it shipped, which is the dry run's
 * purpose (ADR 0012), and a write still stops at the approval gate on its first call (ADR 0008).
 *
 * **A person's own tool of the name is answered as it is** (the shadow rule): nothing is written,
 * so a tool the person authored before stock existed is never overwritten. **No writer shares a
 * directory** (Greptile on #184, GRA-265): the files go to this copy's own directory with nothing
 * held, then the rows are written in one short transaction under the person's lock on the name
 * (`ToolDeps.lockToolName`), which a publish of the name takes for its rows too. Once held the tool
 * is looked for again: a copy or a publish that made it meanwhile is answered, and this copy's
 * directory stays as an orphan with no row (nothing under `tools/` is removed, ADR 0009). Should a
 * writer that takes no lock still win the insert, the unique constraint refuses this copy and it
 * answers the winner's row.
 */
export async function copyStockVersion(
  deps: CopyStockDeps,
  args: {
    personId: string;
    /** The agent whose call made the copy; carried to the mirror event, never to a row. */
    agentId?: string | null;
    stock: StockToolView;
    defaultConnectionId: string | null;
  },
): Promise<AuthoredToolRow> {
  const { stock, personId } = args;
  const key = { vendor: stock.vendor, name: stock.name };
  const existing = await deps.tool.findAuthoredTool(deps.db, personId, key);
  if (existing) return existing;

  const toolboxId = toolboxIdOf(personId);
  const versionPath = writePath(stock.vendor, stock.name, (deps.writeId ?? newWriteId)(deps.now()));
  const written = normaliseManifest(stock.files);
  await deps.store.writeTree(toolboxId, versionPath, written);
  const principal = { personId };
  const definition = {
    description: stock.description,
    inputSchema: stock.inputSchema,
    annotations: stock.annotations,
    defaultConnectionId: args.defaultConnectionId,
  };
  try {
    const outcome = await deps.db.transaction(async (tx) => {
      await deps.tool.lockToolName(tx, personId, key);
      const raced = await deps.tool.findAuthoredTool(tx, personId, key);
      if (raced) return { tool: raced, recorded: null };
      const scoped: ServiceContext = { db: tx };
      const tool = await createTool(scoped, principal, { ...key, ...definition }, deps.tool);
      const recorded = await recordPublishedVersion(
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
      return { tool: recorded.tool, recorded };
    });
    if (outcome.recorded) {
      startMirror(
        deps,
        { personId, agentId: args.agentId ?? null, toolboxId },
        outcome.recorded,
        versionPath,
      );
    }
    return outcome.tool;
  } catch (error) {
    const conflict =
      (error instanceof ServiceError && error.code === "CONFLICT") || isUniqueViolation(error);
    if (!conflict) throw error;
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
 * **A directory of its own, then the rows under the locks** (GRA-238, GRA-265): the stock
 * version's files go to this advance's own write directory (`@graft/toolbox`'s `writePath`) with
 * nothing held, as a copy's and a publish's do, so no writer ever writes over another's files.
 * The rows are one transaction that takes the person's lock on the tool's name
 * (`ToolDeps.lockToolName`, which a publish's rows and a copy take) and the tool row's
 * (`findAuthoredToolForUpdate`), and only then reads the versions and decides, so two reaches of
 * one copy at once serialise: the second reads the version the first recorded and stays, and its
 * directory is left as an orphan with no row (nothing under `tools/` is removed, ADR 0009). A
 * version a remix records at the same moment is decided under the same name lock, and a writer
 * that takes none is caught by the version number's unique constraint, the advance answering the
 * tool as that writer left it. Once committed, the mirror is asked for the version as a publish
 * asks it.
 *
 * The connection a copy was bound to is kept: an advance changes the code and the definition,
 * never the binding. Approvals are not touched here; what an advance does to one is ADR 0008's
 * amendment of 2026-10-09 and GRA-245's, which reads `previous` beside the new annotations.
 */
export async function advanceStockCopy(
  deps: CopyStockDeps,
  args: {
    personId: string;
    toolId: string;
    stock: StockToolView;
    /** The agent whose reach made the advance; carried to the mirror event, never to a row. */
    agentId?: string | null;
  },
): Promise<StockAdvance> {
  const { stock, personId } = args;
  const principal = { personId };
  const ctx: ServiceContext = { db: deps.db };
  const toolboxId = toolboxIdOf(personId);
  const named = await deps.tool.findAuthoredToolById(deps.db, personId, args.toolId);
  if (!named) throw new ServiceError("NOT_FOUND", "Tool not found");
  const key = { vendor: named.vendor, name: named.name };
  const versionPath = writePath(key.vendor, key.name, (deps.writeId ?? newWriteId)(deps.now()));
  const written = normaliseManifest(stock.files);
  await deps.store.writeTree(toolboxId, versionPath, written);
  try {
    const outcome = await ctx.db.transaction(async (tx): Promise<StockAdvance> => {
      const scoped: ServiceContext = { db: tx };
      await deps.tool.lockToolName(tx, personId, key);
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

      const previous = { readOnly: tool.readOnly, destructive: tool.destructive };
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
      return {
        advanced: true,
        tool: recorded.tool,
        version: recorded.version,
        previous,
        stockVersionNumber: decision.stockVersionNumber,
      };
    });
    if (outcome.advanced) {
      startMirror(
        deps,
        { personId, agentId: args.agentId ?? null, toolboxId },
        { tool: outcome.tool, version: outcome.version },
        versionPath,
      );
    }
    return outcome;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await deps.tool.findAuthoredToolById(deps.db, personId, args.toolId);
    if (!raced) throw error;
    return { advanced: false, tool: raced };
  }
}
