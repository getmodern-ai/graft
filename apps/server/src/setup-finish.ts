import {
  type AcquireJobDeps,
  type AgentDeps,
  type ConnectionDeps,
  finishSetup,
  getAcquireJob,
  getConnection,
  getSetupState,
  getToolById,
  moveSetupBuild,
  type Principal,
  type ServiceContext,
  ServiceError,
  type SetupDeps,
  type SetupHarness,
  type SetupState,
  type StarterRunInput,
  starterVendorFor,
  type ToolDeps,
} from "@graft/core";
import type { AcquireJobStatus } from "@graft/db/schema/acquire-job";
import { authoredToolName } from "@graft/mcp";

/**
 * Setup's result and finish steps on the server (GRA-208; ADR 0024; GRA-202, *Building and
 * result*, *The finish step and the prompt*, *Completion*). The routes in `api.ts` are thin over
 * these:
 *
 * - `setupToolContext` (`GET /api/setup/tool`): what both steps draw, the record's agent, harness,
 *   connection, the goal the job was built for, where the job stands, the tool once it landed (its
 *   input schema and annotation, which the result step runs it with) and the starter's run input.
 *   The run itself is the agent's route, `POST /api/agents/:id/tools/:vendor/:name/run`
 *   (`tool-run.ts`), since running a tool is not Setup's.
 * - `completeSetupResult` (`POST /api/setup/result`): the result step's Continue, `result` to
 *   `finish` through `moveSetupBuild`'s `finish`.
 * - `completeSetup` (`POST /api/setup/finish`): `@graft/core`'s `finishSetup`, the record completed
 *   and, for a static-token harness whose agent still awaits it, the token issued in the same
 *   transaction and answered beside the state, once.
 */

export type SetupFinishRouteDeps = {
  setup: SetupDeps;
  agent: AgentDeps;
  connection: ConnectionDeps;
  tool: ToolDeps;
  acquireJob: AcquireJobDeps;
};

/** `GET /api/setup/tool`: what the result and finish steps draw. */
export type SetupToolContext = {
  agent: { id: string; name: string } | null;
  /** Null when Setup adopted an agent whose harness was already connected. */
  harness: SetupHarness | null;
  connection: { id: string; vendor: string; displayName: string } | null;
  /** The goal the job was built for; null with no job on the record. */
  goal: string | null;
  /** Where the job stands, with the failure's sentence once it failed. */
  job: { id: string; status: AcquireJobStatus; failure: string | null } | null;
  /** The tool once it landed; null while the job runs (*Continue while it builds*) or after it failed. */
  tool: {
    id: string;
    vendor: string;
    name: string;
    wireName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
  } | null;
  /** The starter's run input with its default (the city for Open-Meteo); null for any other vendor. */
  runInput: StarterRunInput | null;
};

function failureOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const message = (result as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

export async function setupToolContext(
  ctx: ServiceContext,
  principal: Principal,
  deps: SetupFinishRouteDeps,
): Promise<SetupToolContext> {
  const state = await getSetupState(ctx, principal, deps.setup, deps.agent);
  const record = state.setup;
  const agent = state.agent;
  const scope = agent ? { personId: principal.personId, agentId: agent.id } : null;
  const [connection, job, tool] = await Promise.all([
    record?.connectionId
      ? getConnection(ctx, principal, record.connectionId, deps.connection)
      : null,
    scope && record?.acquireJobId
      ? getAcquireJob(ctx, scope, record.acquireJobId, deps.acquireJob)
      : null,
    record?.toolId ? getToolById(ctx, principal, record.toolId, deps.tool) : null,
  ]);
  const vendor = tool?.vendor ?? connection?.vendor ?? null;
  return {
    agent: agent ? { id: agent.id, name: agent.name } : null,
    harness: record?.harness ?? null,
    connection: connection
      ? { id: connection.id, vendor: connection.vendor, displayName: connection.displayName }
      : null,
    goal: job?.goal ?? null,
    job: job
      ? {
          id: job.id,
          status: job.status,
          failure: job.status === "failed" ? failureOf(job.result) : null,
        }
      : null,
    tool: tool
      ? {
          id: tool.id,
          vendor: tool.vendor,
          name: tool.name,
          wireName: authoredToolName(tool.vendor, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          readOnly: tool.readOnly,
        }
      : null,
    runInput: vendor ? (starterVendorFor(vendor)?.runInput ?? null) : null,
  };
}

/** The result step's Continue: on to the finish with the job and the tool kept. */
export async function completeSetupResult(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupFinishRouteDeps, "setup" | "agent">,
): Promise<SetupState> {
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  if (record?.step !== "result" || !record.acquireJobId) {
    throw new ServiceError("CONFLICT", "Setup is not on the result step", {
      details: { reason: "setup_step", step: record?.step ?? null },
    });
  }
  const { state } = await moveSetupBuild(
    ctx,
    principal,
    { kind: "finish", acquireJobId: record.acquireJobId },
    deps.setup,
    deps.agent,
  );
  return state;
}

/** `POST /api/setup/finish`'s answer: the state, completed, and the token when one was issued. */
export type SetupFinishOutput = SetupState & { token: string | null };

export async function completeSetup(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupFinishRouteDeps, "setup" | "agent">,
): Promise<SetupFinishOutput> {
  const { state, token } = await finishSetup(ctx, principal, deps.setup, deps.agent);
  return { ...state, token };
}
