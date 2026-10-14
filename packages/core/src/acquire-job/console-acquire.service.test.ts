import type { AcquireJobRow } from "@graft/db/repo/acquire-job";
import type { AgentRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PROVIDERS } from "../connection/provider";
import type { ServiceContext } from "../context";
import {
  CONNECTION_ACQUIRE_JOBS_LIMIT,
  CONNECTION_ACQUIRE_JOBS_WINDOW_MS,
  type ConsoleAcquireDeps,
  listConnectionAcquireJobs,
  startConsoleAcquire,
} from "./console-acquire.service";

/**
 * The console's build outside Setup (GRA-303) over fakes: what is asserted is the order of the
 * refusals, the build approval granted for the pair, and the job made, all in one transaction.
 */

const NOW = new Date("2026-10-14T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };
const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

const agent: AgentRow = {
  id: "agent_1",
  personId: "person_1",
  name: "Claude",
  tokenHash: null,
  tokenPrefix: null,
  connectedViaClientId: "client_1",
  connectedViaClientName: "Claude",
  scopeMode: "all",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const connection: ConnectionRow = {
  id: "conn_1",
  personId: "person_1",
  provider: "keyring",
  providerRef: null,
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  scheme: "none",
  schemeConfig: {},
  primaryHost: "https://api.open-meteo.com",
  hosts: ["api.open-meteo.com"],
  credentialCiphertext: null,
  credentialSetAt: null,
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthScopes: null,
  oauthRefreshState: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

function world(
  options: {
    agent?: AgentRow | null;
    connection?: ConnectionRow | null;
    scope?: readonly string[];
  } = {},
) {
  const agentRow = options.agent === undefined ? agent : options.agent;
  const connectionRow = options.connection === undefined ? connection : options.connection;
  const jobs: Record<string, unknown>[] = [];
  const grants: Record<string, unknown>[] = [];
  const findConnection = vi.fn(async () => connectionRow);
  const deps = {
    agent: {
      findAgentForUpdate: vi.fn(async () => agentRow),
      listScopeConnectionIds: vi.fn(async () => options.scope ?? ["conn_1"]),
    },
    connection: {
      findConnection,
      findConnectionForUpdate: vi.fn(async () => connectionRow),
      providers: DEFAULT_PROVIDERS,
    },
    approval: {
      findConnection,
      insertBuildApproval: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
        grants.push(row);
        return row;
      }),
      findBuildApproval: vi.fn(async () => null),
      now: () => NOW,
    },
    acquireJob: {
      findConnection,
      insertAcquireJob: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
        jobs.push(row);
        return row as unknown as AcquireJobRow;
      }),
      listAcquireJobsForConnection: vi.fn(async () => []),
      newId: () => "job_1",
      now: () => NOW,
    },
  } as unknown as ConsoleAcquireDeps;
  return { deps, jobs, grants };
}

const input = {
  agentId: "agent_1",
  connectionId: "conn_1",
  goal: "Read the weather in Melbourne",
  firstProgressLine: "Queued.",
};

describe("startConsoleAcquire", () => {
  it("grants the build approval for the pair and makes the agent's job", async () => {
    const w = world();
    const started = await startConsoleAcquire(ctx, PRINCIPAL, input, w.deps);
    expect(started.agent).toEqual({ id: "agent_1", name: "Claude" });
    expect(w.grants).toEqual([{ agentId: "agent_1", connectionId: "conn_1", grantedAt: NOW }]);
    expect(w.jobs).toEqual([
      expect.objectContaining({
        id: "job_1",
        agentId: "agent_1",
        connectionId: "conn_1",
        goal: input.goal,
        progress: ["Queued."],
      }),
    ]);
    expect(w.deps.agent.findAgentForUpdate).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1");
    // The connection is read locked, so a revoke deleting build approvals cannot interleave
    // between the read and the grant (Greptile on #237).
    expect(w.deps.connection.findConnectionForUpdate).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "conn_1",
    );
  });

  it("is not found for an agent or a connection that is not the person's", async () => {
    await expect(
      startConsoleAcquire(ctx, PRINCIPAL, input, world({ agent: null }).deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Agent not found" });
    await expect(
      startConsoleAcquire(ctx, PRINCIPAL, input, world({ connection: null }).deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Connection not found" });
  });

  it("refuses a revoked agent, a revoked or unusable connection, and one outside the scope, granting nothing", async () => {
    const cases = [
      [{ agent: { ...agent, revokedAt: NOW } }, "agent_revoked"],
      [{ connection: { ...connection, revokedAt: NOW } }, "connection_revoked"],
      [
        { connection: { ...connection, scheme: "bearer" as const, credentialSetAt: null } },
        "connection_unusable",
      ],
      [{ scope: ["conn_2"] }, "connection_not_in_scope"],
    ] as const;
    for (const [options, reason] of cases) {
      const w = world(options);
      await expect(startConsoleAcquire(ctx, PRINCIPAL, input, w.deps)).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason },
      });
      expect(w.grants).toEqual([]);
      expect(w.jobs).toEqual([]);
    }
  });
});

describe("listConnectionAcquireJobs", () => {
  it("reads the window and the bound under the person, and is not found for another's connection", async () => {
    const w = world();
    await listConnectionAcquireJobs(ctx, PRINCIPAL, "conn_1", w.deps);
    expect(w.deps.acquireJob.listAcquireJobsForConnection).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      {
        connectionId: "conn_1",
        since: new Date(NOW.getTime() - CONNECTION_ACQUIRE_JOBS_WINDOW_MS),
        limit: CONNECTION_ACQUIRE_JOBS_LIMIT,
      },
    );
    await expect(
      listConnectionAcquireJobs(ctx, PRINCIPAL, "conn_1", world({ connection: null }).deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
