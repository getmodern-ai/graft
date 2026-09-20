import type { AgentOutput, AgentScopeMode } from "@graft/core";
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
export type Tool = Jsonified<ToolOutput>;
export type WorkingSetEntry = Jsonified<WorkingSetEntryOutput>;
export type WorkingSetChange = Jsonified<WorkingSetChangeOutput>;

export const agentKeys = {
  all: ["agents"] as const,
  one: (agentId: string) => ["agents", agentId] as const,
  workingSet: (agentId: string) => ["agents", agentId, "working-set"] as const,
  changes: (agentId: string) => ["agents", agentId, "working-set", "changes"] as const,
};

export const agentListQuery = (includeArchived = false) =>
  queryOptions({
    queryKey: [...agentKeys.all, "list", includeArchived] as const,
    queryFn: () =>
      api<{ agents: Agent[] }>(includeArchived ? "/agents?includeArchived=true" : "/agents"),
  });

export const agentsQuery = agentListQuery();

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

export function archiveAgent(agentId: string) {
  return api<{ agent: Agent }>(`/agents/${encodeURIComponent(agentId)}/archive`, {
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
