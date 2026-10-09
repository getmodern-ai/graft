import {
  type AgentScope,
  countWorkingSet,
  decideStockAdvance,
  getAgentScope,
  getToolByName,
  listConnections,
  listToolVersionOrigins,
  promoteTool,
  type ServiceContext,
  type StockConnectProposal,
  type StockLineage,
  type StockToolView,
  stockLineageOf,
} from "@graft/core";
import type { AuthoredToolRow, ToolVersionOrigin } from "@graft/db/repo/tool";

import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";
import { authoredToolName } from "./tool-names";

/**
 * **The one road from stock into a toolbox** (ADR 0025; GRA-238). `ensureToolForAgent` answers the
 * person's tool of a `<vendor>__<name>`, copying the stock tool of that name in first when the
 * person holds none: `run.ts`'s `runAuthoredTool` goes through it, so `run_tool`, a first-class
 * call and the console's run (`apps/server/src/tool-run.ts`) all copy as one; `promoteToolForAgent`
 * goes through it, so `promote` and Setup's promote before a run do too. A copy is made only once
 * per person (`@graft/publish`'s `copyStockVersion`), and a person's own tool of the name always
 * wins (the shadow rule): it is found first and stock is never asked.
 *
 * **A copy needs a connection of the integration in the agent's scope**, which becomes the copy's
 * default binding: matched by vendor slug for now (host matching is GRA-241). With none the answer
 * is `connection_needed`, carrying `connect`, the integration's `request_connection` arguments,
 * and nothing is written, so a person never holds a copy bound to nothing.
 *
 * **A copy the person already holds follows stock** (GRA-242): reaching it here advances it to
 * the catalogue's current version when every version it holds came from stock and the catalogue
 * has moved on (`followStock`), so a run runs, and a promote lists, the version stock answers now.
 * A remix and an authored tool are never touched.
 */

export type EnsuredTool =
  | { ok: true; tool: AuthoredToolRow; copied: boolean; advanced: boolean }
  | {
      ok: false;
      reason: "tool_not_found" | "connection_needed";
      message: string;
      details?: { connect: StockConnectProposal | null };
    };

/** The live connections of a vendor in the agent's scope, by id: what a stock tool can run over. */
export function stockConnectionIds(
  connections: readonly { id: string; vendor: string; revokedAt: Date | null }[],
  scopeIds: readonly string[],
  vendor: string,
): string[] {
  const inScope = new Set(scopeIds);
  return connections
    .filter(
      (connection) =>
        connection.vendor === vendor && connection.revokedAt === null && inScope.has(connection.id),
    )
    .map((connection) => connection.id);
}

/** The sentence for a stock tool whose integration the agent has no connection to. */
export function connectionNeededMessage(wire: string, vendor: string): string {
  return `${wire} is a ready-made tool for ${vendor}, and ${vendor} has no connection in this agent's scope. request_connection with the arguments in connect proposes one; once it is connected, the same call runs the tool.`;
}

export async function ensureToolForAgent(
  deps: McpDeps,
  scope: AgentScope,
  key: { vendor: string; name: string },
): Promise<EnsuredTool> {
  const ctx: ServiceContext = { db: deps.db };
  const principal = { personId: scope.personId };
  const wire = authoredToolName(key.vendor, key.name);
  const own = await getToolByName(ctx, principal, key, deps.tool);
  if (own) {
    const followed = await followStock(deps, scope, own);
    return { ok: true, tool: followed.tool, copied: false, advanced: followed.advanced };
  }
  const stock = (await deps.toolSource?.describe(key)) ?? null;
  if (!stock) {
    return {
      ok: false,
      reason: "tool_not_found",
      message: `No tool named ${key.name} for ${key.vendor} is in this toolbox. find_tool searches it.`,
    };
  }
  const [scopeIds, connections] = await Promise.all([
    getAgentScope(ctx, scope, deps.agent),
    listConnections(ctx, principal, deps.connection),
  ]);
  const [connectionId] = stockConnectionIds(connections, scopeIds, stock.vendor);
  if (!connectionId) {
    return {
      ok: false,
      reason: "connection_needed",
      message: connectionNeededMessage(wire, stock.vendor),
      details: { connect: stock.connect },
    };
  }
  const tool = await (deps.toolSource as NonNullable<McpDeps["toolSource"]>).copy({
    personId: scope.personId,
    stock,
    defaultConnectionId: connectionId,
  });
  return { ok: true, tool, copied: true, advanced: false };
}

/** Each tool's version origins, newest first, keyed by tool id: one read for a whole toolbox. */
export function originsByTool(
  origins: readonly ToolVersionOrigin[],
): Map<string, ToolVersionOrigin[]> {
  const byTool = new Map<string, ToolVersionOrigin[]>();
  for (const origin of origins) {
    const list = byTool.get(origin.toolId) ?? [];
    list.push(origin);
    byTool.set(origin.toolId, list);
  }
  return byTool;
}

/** A tool's lineage off its origins: what `find_tool` marks a hit with (`stock`, `remixed`). */
export function lineageOf(origins: readonly ToolVersionOrigin[] | undefined): StockLineage {
  return stockLineageOf(origins ?? []);
}

/**
 * Advance one tool the caller has already read the origins and the catalogue's entry for, when
 * `@graft/core`'s `decideStockAdvance` says so; the tool as it stands otherwise. The decision is
 * taken again under the tool's lock inside the advance (`@graft/publish`'s `advanceStockCopy`),
 * so this read only spares a transaction for the tools that are not behind.
 */
export async function advanceIfBehind(
  deps: McpDeps,
  personId: string,
  tool: AuthoredToolRow,
  origins: readonly ToolVersionOrigin[],
  stock: StockToolView | null,
): Promise<{ tool: AuthoredToolRow; advanced: boolean }> {
  if (!deps.toolSource || !stock) return { tool, advanced: false };
  const decision = decideStockAdvance({
    versions: origins,
    catalogue: {
      stockToolId: stock.stockToolId,
      stockVersionId: stock.stockVersionId,
      versionNumber: stock.versionNumber,
    },
  });
  if (decision.action === "stay") return { tool, advanced: false };
  const advance = await deps.toolSource.advance({ personId, toolId: tool.id, stock });
  return { tool: advance.tool, advanced: advance.advanced };
}

/**
 * **Reaching a copy advances it** (ADR 0025; GRA-242): the one-tool form `ensureToolForAgent`
 * calls, so a run, a first-class call, the console's run and a promote each move an untouched copy
 * onto the catalogue's current version before they read it. The origins are read first and the
 * catalogue asked only for a tool whose every version came from stock, so a reach of an authored
 * tool or a remix costs one read. An advance announces the reaching agent's list as changed,
 * since the definition it lists moved.
 */
export async function followStock(
  deps: McpDeps,
  scope: AgentScope,
  tool: AuthoredToolRow,
): Promise<{ tool: AuthoredToolRow; advanced: boolean }> {
  if (!deps.toolSource) return { tool, advanced: false };
  const ctx: ServiceContext = { db: deps.db };
  const origins = await listToolVersionOrigins(
    ctx,
    { personId: scope.personId },
    deps.tool,
    tool.id,
  );
  if (lineageOf(origins) !== "stock") return { tool, advanced: false };
  const stock = await deps.toolSource.describe({ vendor: tool.vendor, name: tool.name });
  const followed = await advanceIfBehind(deps, scope.personId, tool, origins, stock);
  if (followed.advanced) deps.notifier?.changed(scope.agentId);
  return followed;
}

export type PromotedTool =
  | { ok: true; tool: string; changed: boolean; workingSetSize: number }
  | {
      ok: false;
      reason: "tool_not_found" | "connection_needed" | "tool_has_no_version";
      message: string;
      details?: { connect: StockConnectProposal | null };
    };

/**
 * Promote a tool for an agent, copying a stock tool in first (`ensureToolForAgent`): `promote`'s
 * body, and the call a console route makes to put a stock tool in an agent's working set before
 * running it (Setup v2). A change is announced through `notifier` when one is given; the server's
 * process notifier is `deps.notifier`.
 */
export async function promoteToolForAgent(
  deps: McpDeps,
  scope: AgentScope,
  key: { vendor: string; name: string },
  notifier: Pick<ToolListChangedNotifier, "changed"> | null = deps.notifier ?? null,
): Promise<PromotedTool> {
  const ensured = await ensureToolForAgent(deps, scope, key);
  if (!ensured.ok) return ensured;
  const { tool } = ensured;
  const wire = authoredToolName(tool.vendor, tool.name);
  // The same refusal a run gives (`run.ts`): a tool no version of which passed its dry run is not
  // promotable, since the list entry would name nothing that runs (GRA-77).
  if (!tool.currentVersionId) {
    return {
      ok: false,
      reason: "tool_has_no_version",
      message: `${wire} has no version that passed its dry run, so there is nothing to promote. acquire authors one.`,
    };
  }
  const ctx: ServiceContext = { db: deps.db };
  const change = await promoteTool(ctx, scope, tool.id, "agent", deps.workingSet);
  if (change.changed) notifier?.changed(scope.agentId);
  return {
    ok: true,
    tool: wire,
    changed: change.changed,
    workingSetSize: await countWorkingSet(ctx, scope, deps.workingSet),
  };
}
