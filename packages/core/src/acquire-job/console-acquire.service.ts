import type { AcquireJobRow, ConnectionAcquireJobRow } from "@graft/db/repo/acquire-job";

import type { AgentDeps } from "../agent/agent.deps";
import { getAgentScope } from "../agent/agent.service";
import type { ApprovalDeps } from "../approval/approval.deps";
import { grantBuildApproval } from "../approval/approval.service";
import type { ConnectionDeps } from "../connection/connection.deps";
import { isConnectionUsable, toConnectionOutput } from "../connection/connection.service";
import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { Principal } from "../tenancy";
import type { AcquireJobDeps } from "./acquire-job.deps";
import { createAcquireJob } from "./acquire-job.service";

/**
 * **The console builds a tool outside Setup** (GRA-303; ADR 0024 as amended 2026-10-14): an
 * integration's page gets a new tool for an agent the person picked before pressing Create.
 * Create is that agent's build approval for the connection, as Build is in Setup
 * (`startSetupBuild`), and the job is an ordinary `acquire` job of that agent's. No Setup record
 * is read or written, and no pending action is opened.
 */

export type StartConsoleAcquireInput = {
  agentId: string;
  connectionId: string;
  goal: string;
  hints?: string | null;
  /** The line the job carries before its runner has said anything. */
  firstProgressLine: string;
};

export type ConsoleAcquireDeps = {
  /** The agent read locked after the connection, so a scope write or a revoke of it waits for the job (`findAgentForUpdate`). */
  agent: AgentDeps;
  /**
   * The connection read locked (`findConnectionForNoKeyUpdate`), so a revoke, which deletes the
   * build approvals under `FOR UPDATE` (`revokeConnection`), waits for the grant and the job, or
   * commits first and is read here as revoked.
   */
  connection: Pick<ConnectionDeps, "findConnection" | "findConnectionForNoKeyUpdate" | "providers">;
  approval: ApprovalDeps;
  acquireJob: AcquireJobDeps;
};

/**
 * One transaction: the agent (the person's, not revoked), the connection (the person's, not
 * revoked, usable, in the agent's scope), the build approval for the pair, and the job. Another
 * person's agent or connection is not found. The caller wakes the runner after the commit.
 */
export async function startConsoleAcquire(
  ctx: ServiceContext,
  principal: Principal,
  input: StartConsoleAcquireInput,
  deps: ConsoleAcquireDeps,
): Promise<{ job: AcquireJobRow; agent: { id: string; name: string } }> {
  return ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    // The connection's lock before the agent's, the order a scope answer takes them
    // (`recordApprovalAnswer`, then `addConnectionToAgentScope`). `NO KEY UPDATE` rather than
    // `UPDATE`, so a scope save holding the agent can still insert its `agent_connection` row
    // (whose foreign-key check takes `KEY SHARE` on the connection) and commit: neither order
    // deadlocks (Greptile on #237).
    const row = orNotFound(
      await deps.connection.findConnectionForNoKeyUpdate(
        tx,
        principal.personId,
        input.connectionId,
      ),
      "Connection not found",
    );
    const agent = orNotFound(
      await deps.agent.findAgentForUpdate(tx, principal.personId, input.agentId),
      "Agent not found",
    );
    if (agent.revokedAt) {
      throw new ServiceError("CONFLICT", `${agent.name} is revoked, so it cannot get a new tool`, {
        details: { reason: "agent_revoked", agentId: agent.id },
      });
    }
    const connection = toConnectionOutput(row);
    // Revoked rows stay in a resolved scope (`getAgentScope`), so the row's own state is read: a
    // job against a connection that cannot carry a call would only fail in the runner.
    if (connection.revokedAt) {
      throw new ServiceError(
        "CONFLICT",
        `${connection.displayName} is revoked, so no tool can be acquired against it until you reconnect it`,
        { details: { reason: "connection_revoked", connectionId: connection.id } },
      );
    }
    if (!isConnectionUsable(connection, deps.connection.providers)) {
      throw new ServiceError(
        "CONFLICT",
        `${connection.displayName} cannot carry a call yet: its credential or sign-in is not in place, so no tool can be acquired against it`,
        { details: { reason: "connection_unusable", connectionId: connection.id } },
      );
    }
    const scope = { personId: principal.personId, agentId: agent.id };
    if (!(await getAgentScope(scoped, scope, deps.agent)).includes(connection.id)) {
      throw new ServiceError(
        "CONFLICT",
        `${connection.displayName} is not in ${agent.name}'s scope, so no tool can be acquired against it for ${agent.name}`,
        { details: { reason: "connection_not_in_scope", connectionId: connection.id } },
      );
    }
    await grantBuildApproval(scoped, scope, connection.id, deps.approval);
    const job = await createAcquireJob(
      scoped,
      scope,
      {
        connectionId: connection.id,
        goal: input.goal,
        hints: input.hints ?? null,
        firstProgressLine: input.firstProgressLine,
      },
      deps.acquireJob,
    );
    return { job, agent: { id: agent.id, name: agent.name } };
  });
}

/** How far back the integration page looks for jobs, and how many it lists at most. */
export const CONNECTION_ACQUIRE_JOBS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CONNECTION_ACQUIRE_JOBS_LIMIT = 20;

/**
 * One connection's jobs of the last `CONNECTION_ACQUIRE_JOBS_WINDOW_MS`, newest first, across
 * the person's agents, so a reload or a closed dialog finds the job the console started (ADR 0024
 * as amended 2026-10-14). A connection that is not the person's is not found.
 */
export async function listConnectionAcquireJobs(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: { connection: Pick<ConnectionDeps, "findConnection">; acquireJob: AcquireJobDeps },
): Promise<ConnectionAcquireJobRow[]> {
  orNotFound(
    await deps.connection.findConnection(ctx.db, principal.personId, connectionId),
    "Connection not found",
  );
  return deps.acquireJob.listAcquireJobsForConnection(ctx.db, principal.personId, {
    connectionId,
    since: new Date(deps.acquireJob.now().getTime() - CONNECTION_ACQUIRE_JOBS_WINDOW_MS),
    limit: CONNECTION_ACQUIRE_JOBS_LIMIT,
  });
}
