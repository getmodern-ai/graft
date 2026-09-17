import {
  type AcquireJobDeps,
  type AgentDeps,
  type ApprovalDeps,
  type ConnectionDeps,
  DEFAULT_PROVIDERS,
  hashAgentToken,
  type LedgerDeps,
  type PendingActionDeps,
  type ToolDeps,
  type WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AcquireAttemptRow, AcquireJobRow, AcquireTraceRow } from "@graft/db/repo/acquire-job";
import type { AgentRow } from "@graft/db/repo/agent";
import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { ConnectionRow } from "@graft/db/repo/connection";
import type { listPendingActionsByKind, PendingActionRow } from "@graft/db/repo/pending-action";
import type { AuthoredToolRow, ToolVersionRow } from "@graft/db/repo/tool";
import type { UsageLedgerRow } from "@graft/db/repo/usage";
import type { WorkingSetChangeRow, WorkingSetRow } from "@graft/db/repo/working-set";
import type { ConnectionScheme } from "@graft/db/schema/connection";

/**
 * The five service seams over in-memory maps — what `server.test.ts` binds `McpDeps` to, so the
 * suite runs the real services (`@graft/core`) with no database. Every read takes the person or the
 * scope as the repo functions do, and answers nothing for another person's row, which is what the
 * scope tests here rely on. The acquire job, its attempts and its trace (GRA-29) are the last three
 * maps. The shape is a plain object of maps rather than a class so a test can reach in and assert.
 */

export type FakeStore = {
  agents: Map<string, AgentRow>;
  /** agent id -> connection ids in its scope */
  agentConnections: Map<string, Set<string>>;
  connections: Map<string, ConnectionRow>;
  tools: Map<string, AuthoredToolRow>;
  versions: Map<string, ToolVersionRow>;
  /** `<agentId> <toolId>` -> row */
  workingSet: Map<string, WorkingSetRow>;
  changes: WorkingSetChangeRow[];
  usage: UsageLedgerRow[];
  /** `<agentId> <toolId>` -> row (ADR 0008) */
  approvals: Map<string, ApprovalRow>;
  /** `<agentId> <connectionId>` -> row */
  buildApprovals: Map<string, BuildApprovalRow>;
  pendingActions: Map<string, PendingActionRow>;
  acquireJobs: Map<string, AcquireJobRow>;
  acquireAttempts: Map<string, AcquireAttemptRow>;
  acquireTraces: AcquireTraceRow[];
  now: () => Date;
  /** The next generated id. */
  newId: () => string;
  addAgent(input: {
    id: string;
    personId: string;
    token: string;
    name?: string;
    connectionIds?: readonly string[];
  }): AgentRow;
  addConnection(input: {
    id: string;
    personId: string;
    vendor: string;
    displayName?: string;
    scheme?: ConnectionScheme;
    schemeConfig?: Record<string, string>;
    primaryHost: string;
    hosts?: readonly string[];
  }): ConnectionRow;
  /** A tool with one published version and the pointer on it — what GRA-18's publish leaves behind. */
  addTool(input: {
    id: string;
    personId: string;
    vendor: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
    destructive: boolean;
    defaultConnectionId: string | null;
    path: string;
  }): { tool: AuthoredToolRow; version: ToolVersionRow };
  promote(agentId: string, toolId: string): void;
  isPromoted(agentId: string, toolId: string): boolean;
  /** The person's standing yes to code running against a connection for this agent (ADR 0008). */
  grantBuild(agentId: string, connectionId: string): void;
};

const key = (agentId: string, toolId: string) => `${agentId} ${toolId}`;

export function createFakeStore(options: { now?: () => Date } = {}): FakeStore {
  const now = options.now ?? (() => new Date());
  let counter = 0;
  const store: FakeStore = {
    agents: new Map(),
    agentConnections: new Map(),
    connections: new Map(),
    tools: new Map(),
    versions: new Map(),
    workingSet: new Map(),
    changes: [],
    usage: [],
    approvals: new Map(),
    buildApprovals: new Map(),
    pendingActions: new Map(),
    acquireJobs: new Map(),
    acquireAttempts: new Map(),
    acquireTraces: [],
    now,
    newId: () => `id_${++counter}`,
    addAgent(input) {
      const at = now();
      const row: AgentRow = {
        id: input.id,
        personId: input.personId,
        name: input.name ?? input.id,
        tokenHash: hashAgentToken(input.token),
        tokenPrefix: input.token.slice(0, 8),
        connectedViaClientId: null,
        connectedViaClientName: null,
        workingSetCap: 20,
        idleWindowDays: 21,
        revokedAt: null,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.agents.set(row.id, row);
      store.agentConnections.set(row.id, new Set(input.connectionIds ?? []));
      return row;
    },
    addConnection(input) {
      const at = now();
      const primary = new URL(input.primaryHost);
      const row: ConnectionRow = {
        id: input.id,
        personId: input.personId,
        provider: "keyring",
        providerRef: null,
        vendor: input.vendor,
        displayName: input.displayName ?? input.vendor,
        scheme: input.scheme ?? "api_key_header",
        schemeConfig: input.schemeConfig ?? { headerName: "x-demo-key" },
        primaryHost: input.primaryHost,
        hosts: [...new Set([primary.hostname, ...(input.hosts ?? [])])],
        credentialCiphertext: null,
        credentialSetAt: at,
        oauthClientId: null,
        oauthClientSecretCiphertext: null,
        oauthAuthorizeUrl: null,
        oauthTokenUrl: null,
        oauthScopes: null,
        oauthRefreshState: null,
        revokedAt: null,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.connections.set(row.id, row);
      return row;
    },
    addTool(input) {
      const at = now();
      const version: ToolVersionRow = {
        id: `${input.id}_v1`,
        toolId: input.id,
        versionNumber: 1,
        path: input.path,
        sourceHash: "fixture",
        lockfileHash: null,
        checkOutput: { refusals: [], advice: [] },
        dryRunOutcome: null,
        dryRunAt: null,
        writesInvolved: false,
        publisherJobId: null,
        owner: "person",
        createdAt: at,
      };
      const tool: AuthoredToolRow = {
        id: input.id,
        personId: input.personId,
        vendor: input.vendor,
        name: input.name,
        description: input.description,
        inputSchema: input.inputSchema,
        currentVersionId: version.id,
        readOnly: input.readOnly,
        destructive: input.destructive,
        defaultConnectionId: input.defaultConnectionId,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.versions.set(version.id, version);
      store.tools.set(tool.id, tool);
      return { tool, version };
    },
    promote(agentId, toolId) {
      const at = now();
      store.workingSet.set(key(agentId, toolId), {
        agentId,
        toolId,
        promotedAt: at,
        lastUsedAt: null,
        promotedBy: "publish",
        owner: "person",
        createdAt: at,
        updatedAt: at,
      });
    },
    isPromoted(agentId, toolId) {
      return store.workingSet.has(key(agentId, toolId));
    },
    grantBuild(agentId, connectionId) {
      const at = now();
      store.buildApprovals.set(key(agentId, connectionId), {
        agentId,
        connectionId,
        grantedAt: at,
        owner: "person",
        createdAt: at,
      });
    },
  };
  return store;
}

export type FakeDeps = {
  db: DbOrTx;
  agent: AgentDeps;
  connection: ConnectionDeps;
  tool: ToolDeps;
  workingSet: WorkingSetDeps;
  ledger: LedgerDeps;
  approval: ApprovalDeps;
  pendingAction: PendingActionDeps;
  listPendingActionsByKind: typeof listPendingActionsByKind;
  acquireJob: AcquireJobDeps;
};

/** The deps over a store. `db` is never dereferenced; the transaction fake hands itself to its body. */
export function createFakeDeps(store: FakeStore): FakeDeps {
  const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
  const db = fakeDb as unknown as DbOrTx;
  const ownsAgent = (scope: { personId: string; agentId: string }) =>
    store.agents.get(scope.agentId)?.personId === scope.personId;

  const agent: AgentDeps = {
    insertAgent: async (_db, input) => {
      const at = store.now();
      const row: AgentRow = {
        id: input.id,
        personId: input.personId,
        name: input.name,
        tokenHash: input.tokenHash ?? null,
        tokenPrefix: input.tokenPrefix ?? null,
        connectedViaClientId: input.connectedViaClientId ?? null,
        connectedViaClientName: input.connectedViaClientName ?? null,
        workingSetCap: input.workingSetCap ?? 20,
        idleWindowDays: input.idleWindowDays ?? 21,
        revokedAt: null,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.agents.set(row.id, row);
      store.agentConnections.set(row.id, new Set());
      return row;
    },
    findAgent: async (_db, personId, agentId) => {
      const row = store.agents.get(agentId);
      return row && row.personId === personId ? row : null;
    },
    findAgentByTokenHash: async (_db, tokenHash) =>
      [...store.agents.values()].find((row) => row.tokenHash === tokenHash && !row.revokedAt) ??
      null,
    // The store holds no OAuth tokens (ADR 0018): the suites here drive static tokens, and the
    // authorization server's own suite in `@graft/core` drives the OAuth path over its own fakes.
    findAgentByMcpAccessTokenHash: async () => null,
    revokeMcpTokensForAgent: async () => 0,
    setAgentConnectedVia: async (_db, personId, agentId, via) => {
      const row = store.agents.get(agentId);
      if (!row || row.personId !== personId || row.connectedViaClientId) return null;
      const updated = {
        ...row,
        connectedViaClientId: via.clientId,
        connectedViaClientName: via.clientName,
      };
      store.agents.set(agentId, updated);
      return updated;
    },
    listAgents: async (_db, personId) =>
      [...store.agents.values()].filter((row) => row.personId === personId),
    updateAgent: async (_db, personId, agentId, patch) => {
      const row = store.agents.get(agentId);
      if (!row || row.personId !== personId) return null;
      const updated = { ...row, ...patch, updatedAt: store.now() };
      store.agents.set(agentId, updated);
      return updated;
    },
    revokeAgent: async (_db, personId, agentId, at) => {
      const row = store.agents.get(agentId);
      if (!row || row.personId !== personId || row.revokedAt) return null;
      const updated = { ...row, revokedAt: at };
      store.agents.set(agentId, updated);
      return updated;
    },
    replaceAgentConnections: async (_db, scope, connectionIds) => {
      if (!ownsAgent(scope)) return;
      store.agentConnections.set(scope.agentId, new Set(connectionIds));
    },
    listAgentConnectionIds: async (_db, scope) =>
      ownsAgent(scope) ? [...(store.agentConnections.get(scope.agentId) ?? [])].sort() : [],
    findConnectionsByIds: async (_db, personId, ids) =>
      ids.flatMap((id) => {
        const row = store.connections.get(id);
        return row && row.personId === personId ? [row] : [];
      }),
    listAllActiveAgents: async () => [...store.agents.values()].filter((row) => !row.revokedAt),
    newId: store.newId,
    now: store.now,
  };

  const connection: ConnectionDeps = {
    insertConnection: async (_db, input) => {
      const at = store.now();
      const row = {
        ...input,
        provider: input.provider ?? "keyring",
        providerRef: input.providerRef ?? null,
        schemeConfig: input.schemeConfig ?? {},
        hosts: input.hosts ?? [],
        credentialCiphertext: null,
        credentialSetAt: null,
        oauthClientId: input.oauthClientId ?? null,
        oauthClientSecretCiphertext: null,
        oauthAuthorizeUrl: input.oauthAuthorizeUrl ?? null,
        oauthTokenUrl: input.oauthTokenUrl ?? null,
        oauthScopes: input.oauthScopes ?? null,
        oauthRefreshState: null,
        revokedAt: null,
        owner: "person" as const,
        createdAt: at,
        updatedAt: at,
      } as ConnectionRow;
      store.connections.set(row.id, row);
      return row;
    },
    findConnection: async (_db, personId, id) => {
      const row = store.connections.get(id);
      return row && row.personId === personId ? row : null;
    },
    findConnectionByIdUnscoped: async (_db, id) => store.connections.get(id) ?? null,
    listConnections: async (_db, personId) =>
      [...store.connections.values()].filter((row) => row.personId === personId),
    setConnectionCredential: async (_db, personId, id, args) => {
      const row = store.connections.get(id);
      if (!row || row.personId !== personId) return null;
      const updated = {
        ...row,
        credentialCiphertext: args.ciphertext,
        credentialSetAt: args.setAt,
        revokedAt: null,
        ...(args.oauthRefreshState === undefined
          ? {}
          : { oauthRefreshState: args.oauthRefreshState }),
      };
      store.connections.set(id, updated);
      return updated;
    },
    setConnectionOAuthState: async (_db, personId, id, state) => {
      const row = store.connections.get(id);
      if (!row || row.personId !== personId) return null;
      const updated = { ...row, oauthRefreshState: state };
      store.connections.set(id, updated);
      return updated;
    },
    /** The repo's statement: every secret the row holds and the consent state go together (ADR 0007). */
    reconnectConnection: async (_db, personId, id) => {
      const row = store.connections.get(id);
      if (!row || row.personId !== personId) return null;
      const updated = { ...row, revokedAt: null };
      store.connections.set(id, updated);
      return updated;
    },
    revokeConnection: async (_db, personId, id, at) => {
      const row = store.connections.get(id);
      if (!row || row.personId !== personId) return null;
      const updated = {
        ...row,
        credentialCiphertext: null,
        credentialSetAt: null,
        oauthClientSecretCiphertext: null,
        oauthRefreshState: null,
        revokedAt: at,
      };
      store.connections.set(id, updated);
      return updated;
    },
    deleteApprovalsForVendor: async (_db, personId, vendor) => {
      const swept: ApprovalRow[] = [];
      for (const [k, row] of store.approvals) {
        const tool = store.tools.get(row.toolId);
        if (tool?.personId === personId && tool.vendor === vendor) {
          swept.push(row);
          store.approvals.delete(k);
        }
      }
      return swept;
    },
    deleteBuildApprovalsForConnection: async (_db, personId, connectionId) => {
      const swept: BuildApprovalRow[] = [];
      for (const [k, row] of store.buildApprovals) {
        if (
          row.connectionId === connectionId &&
          store.connections.get(connectionId)?.personId === personId
        ) {
          swept.push(row);
          store.buildApprovals.delete(k);
        }
      }
      return swept;
    },
    /** The repo's predicate: the connection's open asks of every kind, both clocks stamped. */
    expirePendingActionsForConnection: async (_db, personId, connectionId, at) => {
      const closed: PendingActionRow[] = [];
      for (const [id, row] of store.pendingActions) {
        if (
          row.connectionId === connectionId &&
          store.agents.get(row.agentId)?.personId === personId &&
          row.consumedAt === null &&
          row.expiresAt > at
        ) {
          const updated = { ...row, expiresAt: at, consumedAt: at };
          store.pendingActions.set(id, updated);
          closed.push(updated);
        }
      }
      return closed;
    },
    vault: { encrypt: async () => Buffer.from("ciphertext") },
    providers: DEFAULT_PROVIDERS,
    newId: store.newId,
    now: store.now,
  };

  const tool: ToolDeps = {
    insertAuthoredTool: async (_db, input) => {
      const at = store.now();
      const row: AuthoredToolRow = {
        id: input.id,
        personId: input.personId,
        vendor: input.vendor,
        name: input.name,
        description: input.description,
        inputSchema: input.inputSchema,
        currentVersionId: input.currentVersionId ?? null,
        readOnly: input.readOnly,
        destructive: input.destructive,
        defaultConnectionId: input.defaultConnectionId ?? null,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.tools.set(row.id, row);
      return row;
    },
    findAuthoredTool: async (_db, personId, { vendor, name }) =>
      [...store.tools.values()].find(
        (row) => row.personId === personId && row.vendor === vendor && row.name === name,
      ) ?? null,
    findAuthoredToolById: async (_db, personId, id) => {
      const row = store.tools.get(id);
      return row && row.personId === personId ? row : null;
    },
    listAuthoredTools: async (_db, personId) =>
      [...store.tools.values()]
        .filter((row) => row.personId === personId)
        .sort((a, b) => `${a.vendor}/${a.name}`.localeCompare(`${b.vendor}/${b.name}`)),
    updateAuthoredTool: async (_db, personId, id, patch) => {
      const row = store.tools.get(id);
      if (!row || row.personId !== personId) return null;
      const updated = { ...row, ...patch, updatedAt: store.now() };
      store.tools.set(id, updated);
      return updated;
    },
    insertToolVersion: async (_db, input) => {
      const row: ToolVersionRow = {
        id: input.id,
        toolId: input.toolId,
        versionNumber: input.versionNumber,
        path: input.path,
        sourceHash: input.sourceHash,
        lockfileHash: input.lockfileHash ?? null,
        checkOutput: input.checkOutput,
        dryRunOutcome: input.dryRunOutcome ?? null,
        dryRunAt: input.dryRunAt ?? null,
        writesInvolved: input.writesInvolved ?? false,
        publisherJobId: input.publisherJobId ?? null,
        owner: "person",
        createdAt: store.now(),
      };
      store.versions.set(row.id, row);
      return row;
    },
    listToolVersions: async (_db, personId, toolId) => {
      const owner = store.tools.get(toolId);
      if (!owner || owner.personId !== personId) return [];
      return [...store.versions.values()]
        .filter((row) => row.toolId === toolId)
        .sort((a, b) => b.versionNumber - a.versionNumber);
    },
    findToolVersion: async (_db, personId, versionId) => {
      const row = store.versions.get(versionId);
      if (!row) return null;
      return store.tools.get(row.toolId)?.personId === personId ? row : null;
    },
    setCurrentToolVersion: async (_db, personId, toolId, versionId) => {
      const row = store.tools.get(toolId);
      const version = store.versions.get(versionId);
      if (!row || row.personId !== personId || version?.toolId !== toolId) return null;
      const updated = { ...row, currentVersionId: versionId };
      store.tools.set(toolId, updated);
      return updated;
    },
    recordToolVersionDryRun: async (_db, personId, versionId, outcome) => {
      const row = store.versions.get(versionId);
      if (!row || store.tools.get(row.toolId)?.personId !== personId) return null;
      const updated = {
        ...row,
        dryRunOutcome: outcome.report,
        dryRunAt: outcome.at,
        writesInvolved: outcome.writesInvolved,
      };
      store.versions.set(versionId, updated);
      return updated;
    },
    findConnection: connection.findConnection,
    newId: store.newId,
    now: store.now,
  };

  const workingSet: WorkingSetDeps = {
    listWorkingSet: async (_db, scope) => {
      if (!ownsAgent(scope)) return [];
      return [...store.workingSet.values()]
        .filter((row) => row.agentId === scope.agentId)
        .flatMap((row) => {
          const owned = store.tools.get(row.toolId);
          return owned ? [{ ...row, tool: owned }] : [];
        })
        .sort((a, b) => a.promotedAt.getTime() - b.promotedAt.getTime());
    },
    findWorkingSetEntry: async (_db, scope, toolId) =>
      ownsAgent(scope) ? (store.workingSet.get(key(scope.agentId, toolId)) ?? null) : null,
    countWorkingSet: async (_db, scope) =>
      ownsAgent(scope)
        ? [...store.workingSet.values()].filter((row) => row.agentId === scope.agentId).length
        : 0,
    insertWorkingSetEntry: async (_db, input) => {
      const at = store.now();
      if (store.workingSet.has(key(input.agentId, input.toolId))) return null;
      const row: WorkingSetRow = {
        agentId: input.agentId,
        toolId: input.toolId,
        promotedAt: input.promotedAt ?? at,
        lastUsedAt: input.lastUsedAt ?? null,
        promotedBy: input.promotedBy,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.workingSet.set(key(row.agentId, row.toolId), row);
      return row;
    },
    deleteWorkingSetEntry: async (_db, scope, toolId) => {
      if (!ownsAgent(scope)) return null;
      const row = store.workingSet.get(key(scope.agentId, toolId)) ?? null;
      store.workingSet.delete(key(scope.agentId, toolId));
      return row;
    },
    touchWorkingSetUsed: async (_db, scope, toolId, at) => {
      if (!ownsAgent(scope)) return null;
      const row = store.workingSet.get(key(scope.agentId, toolId));
      if (!row) return null;
      const updated = { ...row, lastUsedAt: at, updatedAt: at };
      store.workingSet.set(key(scope.agentId, toolId), updated);
      return updated;
    },
    insertWorkingSetChange: async (_db, input) => {
      const row: WorkingSetChangeRow = {
        id: input.id,
        agentId: input.agentId,
        toolId: input.toolId,
        change: input.change,
        cause: input.cause,
        owner: "person",
        createdAt: input.createdAt ?? store.now(),
      };
      store.changes.push(row);
      return row;
    },
    listWorkingSetChanges: async (_db, scope, limit) =>
      ownsAgent(scope)
        ? store.changes
            .filter((row) => row.agentId === scope.agentId)
            .reverse()
            .slice(0, limit)
        : [],
    findAuthoredToolById: tool.findAuthoredToolById,
    newId: store.newId,
    now: store.now,
  };

  const ledger: LedgerDeps = {
    insertUsage: async (_db, input) => {
      const row: UsageLedgerRow = {
        id: input.id,
        agentId: input.agentId,
        toolId: input.toolId ?? null,
        versionId: input.versionId ?? null,
        toolName: input.toolName,
        outcome: input.outcome,
        dryRun: input.dryRun ?? false,
        latencyMs: input.latencyMs,
        owner: "person",
        createdAt: input.createdAt ?? store.now(),
      };
      store.usage.push(row);
      return row;
    },
    listUsage: async (_db, scope, args) =>
      ownsAgent(scope)
        ? store.usage
            .filter(
              (row) =>
                row.agentId === scope.agentId && (!args.since || row.createdAt >= args.since),
            )
            .reverse()
            .slice(0, args.limit)
        : [],
    listUsageForVendor: async (_db, personId, args) =>
      store.usage
        .filter((row) => {
          const owner = store.agents.get(row.agentId);
          if (!owner || owner.personId !== personId) return false;
          const tool = row.toolId ? store.tools.get(row.toolId) : undefined;
          return tool?.vendor === args.vendor || args.toolNames.includes(row.toolName);
        })
        .reverse()
        .slice(0, args.limit)
        .map((row) => ({ ...row, agentName: store.agents.get(row.agentId)?.name ?? "" })),
    lastUsedAtByTool: async (_db, scope) => {
      if (!ownsAgent(scope)) return [];
      const latest = new Map<string, Date>();
      for (const row of store.usage) {
        if (row.agentId !== scope.agentId || !row.toolId) continue;
        const seen = latest.get(row.toolId);
        if (!seen || seen < row.createdAt) latest.set(row.toolId, row.createdAt);
      }
      return [...latest].map(([toolId, lastUsedAt]) => ({ toolId, lastUsedAt }));
    },
    newId: store.newId,
    now: store.now,
  };

  /** The approval rows, with the repo's predicates: the scope on every read and write, the upsert's kept ask-every-call setting. */
  const approval: ApprovalDeps = {
    findApproval: async (_db, scope, toolId) =>
      ownsAgent(scope) ? (store.approvals.get(key(scope.agentId, toolId)) ?? null) : null,
    listApprovals: async (_db, scope) =>
      ownsAgent(scope)
        ? [...store.approvals.values()]
            .filter((row) => row.agentId === scope.agentId)
            .sort((a, b) => a.toolId.localeCompare(b.toolId))
        : [],
    upsertApproval: async (_db, input) => {
      const at = store.now();
      const existing = store.approvals.get(key(input.agentId, input.toolId));
      const row: ApprovalRow = {
        agentId: input.agentId,
        toolId: input.toolId,
        decision: input.decision,
        decidedAt: input.decidedAt,
        askEveryCall: input.askEveryCall ?? existing?.askEveryCall ?? false,
        owner: "person",
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      store.approvals.set(key(row.agentId, row.toolId), row);
      return row;
    },
    updateAskEveryCall: async (_db, scope, toolId, on) => {
      if (!ownsAgent(scope)) return null;
      const row = store.approvals.get(key(scope.agentId, toolId));
      if (!row) return null;
      const updated = { ...row, askEveryCall: on, updatedAt: store.now() };
      store.approvals.set(key(scope.agentId, toolId), updated);
      return updated;
    },
    settleAnsweredToolActions: async (_db, scope, toolId, consumedAt) => {
      if (!ownsAgent(scope)) return [];
      const settled: PendingActionRow[] = [];
      for (const [k, row] of store.pendingActions) {
        if (
          row.agentId === scope.agentId &&
          row.kind === "tool" &&
          row.payload.toolId === toolId &&
          row.answeredAt !== null &&
          row.consumedAt === null
        ) {
          const updated = { ...row, consumedAt, updatedAt: store.now() };
          store.pendingActions.set(k, updated);
          settled.push(updated);
        }
      }
      return settled;
    },
    deleteApproval: async (_db, scope, toolId) => {
      if (!ownsAgent(scope)) return null;
      const row = store.approvals.get(key(scope.agentId, toolId)) ?? null;
      store.approvals.delete(key(scope.agentId, toolId));
      return row;
    },
    findBuildApproval: async (_db, scope, connectionId) =>
      ownsAgent(scope)
        ? (store.buildApprovals.get(key(scope.agentId, connectionId)) ?? null)
        : null,
    insertBuildApproval: async (_db, input) => {
      if (store.buildApprovals.has(key(input.agentId, input.connectionId))) return null;
      const row: BuildApprovalRow = {
        agentId: input.agentId,
        connectionId: input.connectionId,
        grantedAt: input.grantedAt,
        owner: "person",
        createdAt: store.now(),
      };
      store.buildApprovals.set(key(row.agentId, row.connectionId), row);
      return row;
    },
    findAuthoredToolById: tool.findAuthoredToolById,
    findConnection: connection.findConnection,
    now: store.now,
  };

  /** Pending actions, with the repo's predicates: answering needs open and in time, consuming needs answered and untaken. */
  const ownsAction = (personId: string, row: PendingActionRow | undefined) =>
    row !== undefined && store.agents.get(row.agentId)?.personId === personId;
  const pendingAction: PendingActionDeps = {
    insertPendingAction: async (_db, input) => {
      const row: PendingActionRow = {
        id: input.id,
        agentId: input.agentId,
        kind: input.kind,
        payload: input.payload,
        connectionId: input.connectionId ?? null,
        expiresAt: input.expiresAt,
        answeredAt: input.answeredAt ?? null,
        answer: input.answer ?? null,
        consumedAt: input.consumedAt ?? null,
        owner: "person",
        createdAt: input.createdAt ?? store.now(),
        updatedAt: input.updatedAt ?? store.now(),
      };
      store.pendingActions.set(row.id, row);
      return row;
    },
    findPendingAction: async (_db, scope, id) => {
      const row = store.pendingActions.get(id);
      return ownsAgent(scope) && row?.agentId === scope.agentId ? row : null;
    },
    findPendingActionForPerson: async (_db, personId, id) => {
      const row = store.pendingActions.get(id);
      return ownsAction(personId, row) ? (row ?? null) : null;
    },
    listOpenPendingActions: async (_db, personId, now) =>
      [...store.pendingActions.values()]
        .filter(
          (row) => ownsAction(personId, row) && row.answeredAt === null && row.expiresAt > now,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)),
    answerPendingAction: async (_db, personId, id, args) => {
      const row = store.pendingActions.get(id);
      if (!ownsAction(personId, row) || !row) return null;
      if (row.answeredAt !== null || row.expiresAt <= args.answeredAt) return null;
      const updated = { ...row, answer: args.answer, answeredAt: args.answeredAt };
      store.pendingActions.set(id, updated);
      return updated;
    },
    consumePendingAction: async (_db, scope, id, consumedAt) => {
      const row = store.pendingActions.get(id);
      if (!ownsAgent(scope) || row?.agentId !== scope.agentId) return null;
      if (row.answeredAt === null || row.consumedAt !== null) return null;
      const updated = { ...row, consumedAt };
      store.pendingActions.set(id, updated);
      return updated;
    },
    newId: () => `pa_${store.newId()}`,
    now: store.now,
  };

  const listPendingActionsByKind: FakeDeps["listPendingActionsByKind"] = async (
    _db,
    scope,
    kind,
    now,
  ) =>
    ownsAgent(scope)
      ? [...store.pendingActions.values()]
          .filter(
            (row) =>
              row.agentId === scope.agentId &&
              row.kind === kind &&
              row.consumedAt === null &&
              row.expiresAt > now,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      : [];

  /**
   * The acquire job's record, with the repo's predicates: every read and write under the pair, the
   * runner's roster and claim unscoped as the real ones are, the trace numbered per job.
   */
  const ownsJob = (scope: { personId: string; agentId: string }, row: AcquireJobRow | undefined) =>
    row !== undefined && row.agentId === scope.agentId && ownsAgent(scope);
  const runnable = (row: AcquireJobRow, staleBefore: Date) =>
    row.status === "queued" ||
    (row.status === "running" && (row.heartbeatAt === null || row.heartbeatAt < staleBefore));
  const acquireJob: AcquireJobDeps = {
    insertAcquireJob: async (_db, input) => {
      const at = store.now();
      const row: AcquireJobRow = {
        id: input.id,
        agentId: input.agentId,
        connectionId: input.connectionId,
        goal: input.goal,
        hints: input.hints ?? null,
        status: input.status ?? "queued",
        progress: input.progress ?? [],
        attempts: input.attempts ?? 0,
        tokenSpend: input.tokenSpend ?? 0,
        result: input.result ?? null,
        traceRef: input.traceRef ?? null,
        startedAt: input.startedAt ?? null,
        heartbeatAt: input.heartbeatAt ?? null,
        finishedAt: input.finishedAt ?? null,
        toolId: input.toolId ?? null,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.acquireJobs.set(row.id, row);
      return row;
    },
    findAcquireJob: async (_db, scope, id) => {
      const row = store.acquireJobs.get(id);
      return ownsJob(scope, row) ? (row ?? null) : null;
    },
    listAcquireJobs: async (_db, scope, limit) =>
      ownsAgent(scope)
        ? [...store.acquireJobs.values()]
            .filter((row) => row.agentId === scope.agentId)
            .sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
            )
            .slice(0, limit)
        : [],
    updateAcquireJob: async (_db, scope, id, patch) => {
      const row = store.acquireJobs.get(id);
      if (!ownsJob(scope, row) || !row) return null;
      const updated = { ...row, ...patch, updatedAt: store.now() };
      store.acquireJobs.set(id, updated);
      return updated;
    },
    appendAcquireJobProgress: async (_db, scope, id, lines) => {
      const row = store.acquireJobs.get(id);
      if (!ownsJob(scope, row) || !row) return null;
      const updated = { ...row, progress: [...row.progress, ...lines], updatedAt: store.now() };
      store.acquireJobs.set(id, updated);
      return updated;
    },
    recordAcquireJobAttempt: async (_db, scope, id, tokens) => {
      const row = store.acquireJobs.get(id);
      if (!ownsJob(scope, row) || !row) return null;
      const updated = {
        ...row,
        attempts: row.attempts + 1,
        tokenSpend: row.tokenSpend + tokens,
        updatedAt: store.now(),
      };
      store.acquireJobs.set(id, updated);
      return updated;
    },
    addAcquireJobTokenSpend: async (_db, scope, id, tokens) => {
      const row = store.acquireJobs.get(id);
      if (!ownsJob(scope, row) || !row) return null;
      const updated = { ...row, tokenSpend: row.tokenSpend + tokens, updatedAt: store.now() };
      store.acquireJobs.set(id, updated);
      return updated;
    },
    heartbeatAcquireJob: async (_db, scope, id, at) => {
      const row = store.acquireJobs.get(id);
      if (!ownsJob(scope, row) || !row) return null;
      const updated = { ...row, heartbeatAt: at, updatedAt: at };
      store.acquireJobs.set(id, updated);
      return updated;
    },
    listRunnableAcquireJobs: async (_db, args) =>
      [...store.acquireJobs.values()]
        .filter((row) => runnable(row, args.staleBefore))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, args.limit)
        .flatMap((job) => {
          const owner = store.agents.get(job.agentId);
          return owner ? [{ job, personId: owner.personId }] : [];
        }),
    claimAcquireJob: async (_db, id, args) => {
      const row = store.acquireJobs.get(id);
      if (!row || !runnable(row, args.staleBefore)) return null;
      const updated: AcquireJobRow = {
        ...row,
        status: "running",
        startedAt: row.startedAt ?? args.now,
        heartbeatAt: args.now,
        updatedAt: args.now,
      };
      store.acquireJobs.set(id, updated);
      return updated;
    },
    insertAcquireAttempt: async (_db, input) => {
      const at = store.now();
      if (
        [...store.acquireAttempts.values()].some(
          (row) => row.jobId === input.jobId && row.attemptNumber === input.attemptNumber,
        )
      ) {
        throw new Error(
          `duplicate key value violates unique constraint "acquire_attempt_job_id_attempt_number_unique"`,
        );
      }
      const row: AcquireAttemptRow = {
        id: input.id,
        jobId: input.jobId,
        agentId: input.agentId,
        attemptNumber: input.attemptNumber,
        draftPath: input.draftPath,
        files: input.files,
        checkOutput: input.checkOutput ?? null,
        versionId: input.versionId ?? null,
        diagnosis: input.diagnosis ?? null,
        outcome: input.outcome ?? "running",
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        finishedAt: input.finishedAt ?? null,
        owner: "person",
        createdAt: at,
        updatedAt: at,
      };
      store.acquireAttempts.set(row.id, row);
      return row;
    },
    updateAcquireAttempt: async (_db, scope, id, patch) => {
      const row = store.acquireAttempts.get(id);
      if (!row || row.agentId !== scope.agentId || !ownsAgent(scope)) return null;
      const updated = { ...row, ...patch, updatedAt: store.now() };
      store.acquireAttempts.set(id, updated);
      return updated;
    },
    listAcquireAttempts: async (_db, scope, jobId) =>
      ownsAgent(scope)
        ? [...store.acquireAttempts.values()]
            .filter((row) => row.jobId === jobId && row.agentId === scope.agentId)
            .sort((a, b) => a.attemptNumber - b.attemptNumber)
        : [],
    insertAcquireTrace: async (_db, input) => {
      const sequence = store.acquireTraces.filter((row) => row.jobId === input.jobId).length + 1;
      const row: AcquireTraceRow = {
        id: input.id,
        jobId: input.jobId,
        agentId: input.agentId,
        attemptNumber: input.attemptNumber ?? null,
        sequence,
        kind: input.kind,
        text: input.text,
        data: input.data ?? null,
        redacted: input.redacted ?? false,
        owner: "person",
        createdAt: store.now(),
      };
      store.acquireTraces.push(row);
      return row;
    },
    listAcquireTraces: async (_db, scope, jobId, limit) =>
      ownsAgent(scope)
        ? store.acquireTraces
            .filter((row) => row.jobId === jobId && row.agentId === scope.agentId)
            .sort((a, b) => a.sequence - b.sequence)
            .slice(0, limit)
        : [],
    findConnection: connection.findConnection,
    newId: () => `acq_${store.newId()}`,
    now: store.now,
  };

  return {
    db,
    agent,
    connection,
    tool,
    workingSet,
    ledger,
    approval,
    pendingAction,
    listPendingActionsByKind,
    acquireJob,
  };
}
