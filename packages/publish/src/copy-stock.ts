import {
  createTool,
  isUniqueViolation,
  publishToolVersion as recordPublishedVersion,
  type ServiceContext,
  ServiceError,
  type StockToolView,
} from "@graft/core";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
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
