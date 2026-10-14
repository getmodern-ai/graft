import type {
  AgentListAnswer,
  AgentListOutput,
  AgentOutput,
  AgentScopeMode,
  AgentScopeToggleOutput,
} from "@graft/core";
import type {
  ScopeBody,
  ToolOutput,
  WorkingSetChangeOutput,
  WorkingSetEntryOutput,
} from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";

/**
 * Agents, as the console reads and edits them (ADR 0007: an agent holds a scope and a working set
 * and nothing else of its own). The shapes are the server's, jsonified — see `api.ts`. The scope
 * has a mode since ADR 0007's amendment of 2026-09-19 — `all` or `listed`, on `Agent.scopeMode` —
 * and `GET /agents/:id`'s `connectionIds` are the scope as it resolves under it, so the page's
 * picker is pre-filled either way.
 */

export type Agent = Jsonified<AgentOutput>;
export type AgentListItem = Jsonified<AgentListOutput>;
export type Tool = Jsonified<ToolOutput>;
export type WorkingSetEntry = Jsonified<WorkingSetEntryOutput>;
export type WorkingSetChange = Jsonified<WorkingSetChangeOutput>;
/** What turning one connection on or off for one agent answers (GRA-294). */
export type AgentScopeToggle = Jsonified<AgentScopeToggleOutput>;

export const agentKeys = {
  all: ["agents"] as const,
  one: (agentId: string) => ["agents", agentId] as const,
  workingSet: (agentId: string) => ["agents", agentId, "working-set"] as const,
  changes: (agentId: string) => ["agents", agentId, "working-set", "changes"] as const,
};

export const agentsQuery = queryOptions({
  queryKey: agentKeys.all,
  queryFn: () => api<Jsonified<AgentListAnswer>>("/agents"),
});

export const agentQuery = (agentId: string) =>
  queryOptions({
    queryKey: agentKeys.one(agentId),
    queryFn: () =>
      api<{ agent: Agent; connectionIds: string[] }>(`/agents/${encodeURIComponent(agentId)}`),
  });

export const workingSetQuery = (agentId: string) =>
  queryOptions({
    queryKey: agentKeys.workingSet(agentId),
    queryFn: () =>
      api<{ workingSet: WorkingSetEntry[] }>(`/agents/${encodeURIComponent(agentId)}/working-set`),
  });

/** The history, newest first; the server caps a page at 500 and defaults to 50 (GRA-24). */
export const workingSetChangesQuery = (agentId: string, limit = 100) =>
  queryOptions({
    queryKey: [...agentKeys.changes(agentId), limit] as const,
    queryFn: () =>
      api<{ changes: WorkingSetChange[] }>(
        `/agents/${encodeURIComponent(agentId)}/working-set/changes?limit=${limit}`,
      ),
  });

export type CreateAgentInput = {
  name: string;
  workingSetCap?: number;
  idleWindowDays?: number;
  /** `all` when absent; `listed` takes `connectionIds`, which the server refuses beside `all`. */
  scopeMode?: AgentScopeMode;
  connectionIds?: string[];
};

/** The one answer that carries the token (`POST /api/agents`); nothing reads it back afterwards. */
export type CreatedAgent = {
  agent: Agent;
  token: string;
  connectionIds: string[];
};

export function createAgent(input: CreateAgentInput) {
  return api<CreatedAgent>("/agents", { method: "POST", body: input });
}

/**
 * The static token of an agent awaiting its harness (`POST /api/agents/:id/token`, GRA-208), shown
 * once as `createAgent`'s is; the server refuses any other agent.
 */
export function issueAgentToken(agentId: string) {
  return api<{ agent: Agent; token: string }>(`/agents/${encodeURIComponent(agentId)}/token`, {
    method: "POST",
  });
}

/**
 * A new static token for an active agent that has one (`POST /api/agents/:id/token/rotate`,
 * GRA-306), shown once; the old token is refused from the next request on. The server refuses an
 * agent a client connected, one awaiting its first token, and a revoked one.
 */
export function rotateAgentToken(agentId: string) {
  return api<{ agent: Agent; token: string }>(
    `/agents/${encodeURIComponent(agentId)}/token/rotate`,
    { method: "POST" },
  );
}

export type AgentLimitsPatch = {
  name?: string;
  workingSetCap?: number;
  idleWindowDays?: number;
};

export function updateAgentLimits(agentId: string, patch: AgentLimitsPatch) {
  return api<{ agent: Agent }>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function revokeAgent(agentId: string) {
  return api<{ agent: Agent }>(`/agents/${encodeURIComponent(agentId)}/revoke`, {
    method: "POST",
  });
}

/** The body is the server's own shape (`ScopeBody`); `lib/scope-mode.ts`'s `scopeBodyFor` builds it. */
export function setAgentScope(agentId: string, body: ScopeBody) {
  return api<{ agent: Agent; connectionIds: string[] }>(
    `/agents/${encodeURIComponent(agentId)}/scope`,
    { method: "PUT", body },
  );
}

/**
 * One connection on or off for one agent (GRA-294), each a single write under the agent's lock;
 * `lib/scope-toggles.ts` says which a switch makes. `materialised` on a removal says the agent
 * left `all`.
 */
export function grantConnectionToAgent(connectionId: string, agentId: string) {
  return api<AgentScopeToggle>(
    `/connections/${encodeURIComponent(connectionId)}/agents/${encodeURIComponent(agentId)}`,
    { method: "PUT" },
  );
}

export function removeConnectionFromAgent(connectionId: string, agentId: string) {
  return api<AgentScopeToggle>(
    `/connections/${encodeURIComponent(connectionId)}/agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  );
}
