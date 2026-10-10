import {
  type AgentScope,
  type ConnectionOutput,
  countWorkingSet,
  getAgentScope,
  getToolByName,
  isConnectionUsable,
  listConnections,
  promoteTool,
  type ServiceContext,
  type StockConnectProposal,
} from "@graft/core";
import type { AuthoredToolRow } from "@graft/db/repo/tool";

import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";
import { revokedConnectionRefusal } from "./revoke";
import { matchStockConnections, type StockHosts, stockToolRunsOver } from "./stock-match";
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
 * **A copy needs a connection in the agent's scope that the stock tool runs over** (GRA-241;
 * `stock-match.ts`: every host the manifest declares among the connection's, whatever its
 * provider, the vendor slug breaking ties). The connection the caller named (`run_tool`'s
 * `connectionId`), else the one match chosen, becomes the copy's default binding. With no match
 * the answer is `connection_needed`, carrying `connect`, the integration's `request_connection`
 * arguments, and nothing is written. With several matches and no choice the copy holds no default,
 * and each run resolves its connection per agent (`run.ts`), which refuses two matches and no
 * `connectionId` with `alternatives`.
 */

export type EnsureRefusalReason =
  | "tool_not_found"
  | "connection_needed"
  | "connection_not_in_scope"
  | "connection_revoked"
  | "connection_hosts_missing";

export type EnsuredTool =
  | { ok: true; tool: AuthoredToolRow; copied: boolean }
  | {
      ok: false;
      reason: EnsureRefusalReason;
      message: string;
      details?: { connect?: StockConnectProposal | null } & Record<string, unknown>;
    };

/**
 * The connections a stock tool may run over for this agent, before matching: in the agent's scope
 * and usable (`isConnectionUsable`: not revoked, its provider enabled, its credential in place), so
 * a connection outside the scope is never matched, named or chosen.
 */
export function stockCandidates(
  connections: readonly ConnectionOutput[],
  scopeIds: readonly string[],
  providers: McpDeps["connection"]["providers"],
): ConnectionOutput[] {
  const inScope = new Set(scopeIds);
  return connections.filter(
    (connection) => inScope.has(connection.id) && isConnectionUsable(connection, providers),
  );
}

/** The connections in the agent's scope a stock tool runs over, by id, the vendor's slug first. */
export function stockConnectionIds(
  connections: readonly ConnectionOutput[],
  scopeIds: readonly string[],
  stock: StockHosts,
  providers: McpDeps["connection"]["providers"],
): string[] {
  const candidates = stockCandidates(connections, scopeIds, providers);
  return matchStockConnections(stock, candidates).matches.map((connection) => connection.id);
}

/** The sentence for a stock tool whose integration the agent has no connection to. */
export function connectionNeededMessage(wire: string, vendor: string): string {
  return `${wire} is a ready-made tool for ${vendor}, and ${vendor} has no connection in this agent's scope. request_connection with the arguments in connect proposes one; once it is connected, the same call runs the tool.`;
}

/** The sentence for a named connection outside the agent's scope, the run's own (`run.ts`). */
export function namedNotInScopeMessage(wire: string, connectionId: string): string {
  return `${wire} was asked to run against connection ${connectionId}, which is not in this agent's scope. The person can add it in the console.`;
}

/**
 * A connection the caller named for a stock tool, judged before the copy binds to it: in the
 * agent's scope, not revoked, and reaching every host the manifest declares. Null when it may be
 * used.
 */
function namedConnectionRefusal(
  wire: string,
  stock: StockHosts,
  connectionId: string,
  connection: ConnectionOutput | undefined,
  scopeIds: readonly string[],
): Extract<EnsuredTool, { ok: false }> | null {
  if (!connection || !scopeIds.includes(connectionId)) {
    return {
      ok: false,
      reason: "connection_not_in_scope",
      message: namedNotInScopeMessage(wire, connectionId),
    };
  }
  if (connection.revokedAt !== null) {
    const {
      message,
      error: _error,
      reason: _reason,
      ...details
    } = revokedConnectionRefusal(connection);
    return { ok: false, reason: "connection_revoked", message, details };
  }
  if (!stockToolRunsOver(stock, connection)) {
    return {
      ok: false,
      reason: "connection_hosts_missing",
      message: `${wire} calls ${stock.hosts.join(", ")}, and connection ${connectionId} (${connection.displayName}) does not reach all of them, so the tool cannot run over it.`,
      details: { connectionId, hosts: [...stock.hosts] },
    };
  }
  return null;
}

export async function ensureToolForAgent(
  deps: McpDeps,
  scope: AgentScope,
  key: { vendor: string; name: string },
  options: { connectionId?: string } = {},
): Promise<EnsuredTool> {
  const ctx: ServiceContext = { db: deps.db };
  const principal = { personId: scope.personId };
  const wire = authoredToolName(key.vendor, key.name);
  const own = await getToolByName(ctx, principal, key, deps.tool);
  if (own) return { ok: true, tool: own, copied: false };
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
  let defaultConnectionId: string | null;
  if (options.connectionId) {
    const named = connections.find((connection) => connection.id === options.connectionId);
    const refused = namedConnectionRefusal(wire, stock, options.connectionId, named, scopeIds);
    if (refused) return refused;
    defaultConnectionId = options.connectionId;
  } else {
    const candidates = stockCandidates(connections, scopeIds, deps.connection.providers);
    const { matches, chosen } = matchStockConnections(stock, candidates);
    if (matches.length === 0) {
      return {
        ok: false,
        reason: "connection_needed",
        message: connectionNeededMessage(wire, stock.vendor),
        details: { connect: stock.connect },
      };
    }
    defaultConnectionId = chosen?.id ?? null;
  }
  const tool = await (deps.toolSource as NonNullable<McpDeps["toolSource"]>).copy({
    personId: scope.personId,
    agentId: scope.agentId,
    stock,
    defaultConnectionId,
  });
  return { ok: true, tool, copied: true };
}

export type PromotedTool =
  | { ok: true; tool: string; changed: boolean; workingSetSize: number }
  | {
      ok: false;
      reason: EnsureRefusalReason | "tool_has_no_version";
      message: string;
      details?: { connect?: StockConnectProposal | null } & Record<string, unknown>;
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
