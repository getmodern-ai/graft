import {
  type AcquireJobDeps,
  type AgentDeps,
  type ConnectionDeps,
  getConnection,
  listStockToolsForVendor,
  type Principal,
  type ServiceContext,
  ServiceError,
  type SetupDeps,
  type SetupReadyMadeTool,
  type SetupState,
  type StockDeps,
  setupReadyMade,
  starterVendorFor,
  starterVendorOf,
  takeSetupStockTool,
  type WorkingSetDeps,
} from "@graft/core";
import { ensureToolForAgent, type McpDeps } from "@graft/mcp";

/**
 * **Setup's ready-made tools** on the server (GRA-276; ADR 0024 as amended 2026-10-11; ADR 0025).
 * The routes in `api.ts` are thin over these:
 *
 * - `setupReadyMadeTools` (`GET /api/setup/stock?starterId=`): the stock tools the tool step offers
 *   for a starter, `@graft/core`'s `setupReadyMade` over the catalogue's tools of its integration
 *   (`listStockToolsForVendor`, the console's read of one integration's), so the curated list is
 *   offered only where this release holds each tool as read-only.
 * - `readyMadeChoice`: the person's choice judged against that same list for the record's starter
 *   (the tool screen) or its connection's (the task step), so a write, another integration's tool or
 *   one Setup does not offer is refused `NOT_FOUND` before anything is saved or copied.
 * - `takePlannedStock`: the chosen tool taken as Setup's first tool once the record stands on the
 *   task step with its connection, through `@graft/core`'s `takeSetupStockTool`, the copy being
 *   `@graft/mcp`'s `ensureToolForAgent` bound to the record's connection (the road `run_tool` and
 *   `promote` copy by). A promotion is announced to the agent's sessions, as `promote`'s is.
 */

export type SetupStockRouteDeps = {
  setup: SetupDeps;
  agent: AgentDeps;
  connection: ConnectionDeps;
  acquireJob: AcquireJobDeps;
  workingSet: WorkingSetDeps;
  stock: StockDeps;
  /** The MCP endpoint's deps, whose tool source, toolbox and tools the copy writes through. */
  mcp?: McpDeps;
};

/** `GET /api/setup/stock`: the ready-made tools for one starter, or none. */
export type SetupReadyMade = { tools: SetupReadyMadeTool[] };

export async function setupReadyMadeTools(
  ctx: ServiceContext,
  starterId: string,
  deps: Pick<SetupStockRouteDeps, "stock">,
): Promise<SetupReadyMade> {
  const starter = starterVendorOf(starterId);
  if (!starter) return { tools: [] };
  const catalogue = await listStockToolsForVendor(ctx, starter.vendor, deps.stock);
  return { tools: setupReadyMade(starter, catalogue) };
}

/**
 * The person's choice, judged: one of the ready-made tools the step offers for the starter the
 * record waits to connect (the vendor step) or the connection it names (the task step). Answers
 * the offer's entry, whose `goal` is saved beside it.
 */
export async function readyMadeChoice(
  ctx: ServiceContext,
  principal: Principal,
  state: SetupState,
  tool: string,
  deps: Pick<SetupStockRouteDeps, "stock" | "connection">,
): Promise<SetupReadyMadeTool> {
  const record = state.setup;
  let starterId: string | null = null;
  if (state.step === "vendor" && record?.starterId) starterId = record.starterId;
  if (state.step === "goal" && record?.connectionId) {
    const connection = await getConnection(ctx, principal, record.connectionId, deps.connection);
    starterId = connection ? (starterVendorFor(connection.vendor)?.id ?? null) : null;
  }
  if (!record || (state.step !== "vendor" && state.step !== "goal")) {
    throw new ServiceError("CONFLICT", "Setup is not choosing its first tool", {
      details: { reason: "setup_step", step: state.step },
    });
  }
  const offered = starterId ? (await setupReadyMadeTools(ctx, starterId, deps)).tools : [];
  const entry = offered.find((candidate) => candidate.tool === tool);
  if (!entry) {
    throw new ServiceError(
      "NOT_FOUND",
      "That is not one of the ready-made tools Setup offers here",
      {
        details: { reason: "stock_tool_not_offered" },
      },
    );
  }
  return entry;
}

/**
 * Take the ready-made tool the record names as its first tool (`takeSetupStockTool`), once it
 * stands on the task step with a connection. Refused as the core refuses it, and `BAD_REQUEST` on a
 * server with no MCP endpoint to copy through. Answers the state, with the result step's tool.
 */
export async function takePlannedStock(
  ctx: ServiceContext,
  principal: Principal,
  input: { discardJob?: boolean },
  deps: SetupStockRouteDeps,
): Promise<SetupState> {
  const mcp = deps.mcp;
  if (!mcp) {
    throw new ServiceError(
      "BAD_REQUEST",
      "This server has no MCP endpoint configured, so Setup cannot add a ready-made tool",
    );
  }
  const { state, agentId, promoted } = await takeSetupStockTool(ctx, principal, input, {
    setup: deps.setup,
    agent: deps.agent,
    connection: deps.connection,
    acquireJob: deps.acquireJob,
    workingSet: deps.workingSet,
    ensureTool: async (scope, key, connectionId) => {
      const ensured = await ensureToolForAgent(mcp, scope, key, { connectionId });
      return ensured.ok ? { ok: true, tool: ensured.tool } : ensured;
    },
  });
  // After the commit, so a session that lists on the notice sees the promotion.
  if (promoted) mcp.notifier?.changed(agentId);
  return state;
}
