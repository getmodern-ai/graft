import type { ToolLastRunRow } from "@graft/db/repo/usage";

import type { ServiceContext } from "../context";
import { listStockToolsForVendor } from "../stock/stock.service";
import type { Principal } from "../tenancy";
import type { IntegrationToolsDeps } from "./integration-tools.deps";
import type { ToolAnnotations } from "./tool.service";

/**
 * **An integration's tools, as its page lists them** (GRA-293): the person's tools of the vendor
 * and the stock tools of it they hold none of, each with its last run across the person's agents.
 *
 * Two rules from `find_tool`, held here so the page and the agent see one list: a tool with no
 * current version is not listed, since nothing of it has passed a dry run (GRA-77), and a stock
 * tool is hidden by any tool of the person's of the same name, versionless included, since that
 * tool is the one a run reaches (ADR 0025; `@graft/mcp`'s `tools/meta.ts`).
 */

/** When a tool last ran and for which agent; null for a tool that never ran outside a dry run. */
export type IntegrationToolLastRun = {
  at: Date;
  outcome: ToolLastRunRow["outcome"];
  agent: { id: string; name: string };
};

export type IntegrationTool = {
  /** `toolbox` for a tool of the person's, `stock` for a ready-made one not yet copied in. */
  source: "toolbox" | "stock";
  /** The toolbox row's id; null for a stock tool, which has no row until its first run copies it. */
  toolId: string | null;
  name: string;
  /** The wire name, `<vendor>__<name>`. */
  tool: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  lastRun: IntegrationToolLastRun | null;
};

export async function listIntegrationTools(
  ctx: ServiceContext,
  principal: Principal,
  vendor: string,
  deps: IntegrationToolsDeps,
): Promise<IntegrationTool[]> {
  const [rows, stock, runs] = await Promise.all([
    deps.listAuthoredToolsForVendor(ctx.db, principal.personId, vendor),
    listStockToolsForVendor(ctx, vendor, deps),
    deps.lastRunByToolForPerson(ctx.db, principal.personId, { vendor }),
  ]);
  const runByTool = new Map(runs.map((run) => [run.toolId, run]));
  const held = new Set(rows.map((row) => row.name));
  const toolbox: IntegrationTool[] = rows
    .filter((row) => row.currentVersionId !== null)
    .map((row) => {
      const run = runByTool.get(row.id);
      return {
        source: "toolbox",
        toolId: row.id,
        name: row.name,
        tool: `${row.vendor}__${row.name}`,
        description: row.description,
        annotations: { readOnly: row.readOnly, destructive: row.destructive },
        inputSchema: row.inputSchema,
        lastRun: run
          ? {
              at: run.lastRunAt,
              outcome: run.outcome,
              agent: { id: run.agentId, name: run.agentName },
            }
          : null,
      };
    });
  const stocked: IntegrationTool[] = stock
    .filter((entry) => !held.has(entry.name))
    .map((entry) => ({
      source: "stock",
      toolId: null,
      name: entry.name,
      tool: entry.tool,
      description: entry.description,
      annotations: entry.annotations,
      inputSchema: entry.inputSchema,
      lastRun: null,
    }));
  return [...toolbox, ...stocked].sort(byLastRunThenName);
}

/** The most recently run first, then the never-run, the toolbox before stock, each by name. */
function byLastRunThenName(a: IntegrationTool, b: IntegrationTool): number {
  const at = (b.lastRun?.at.getTime() ?? -1) - (a.lastRun?.at.getTime() ?? -1);
  if (at !== 0) return at;
  if (a.source !== b.source) return a.source === "toolbox" ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
