import type { SetupOutput, SetupState, SetupVendorOption } from "@graft/core";
import type { AcquireStatus } from "@graft/mcp/acquire/shapes";
import type {
  SetupBuildBody,
  SetupConnectBody,
  SetupGoalContext,
  SetupGoalSuggestions,
  SetupStartBody,
} from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";

/**
 * Setup as the console reads and moves it (ADR 0024; `apps/server/src/api.ts`, "Setup"). One
 * resource per person: `GET /api/setup` answers the whole state — the record, the step the person
 * is on, the show rule's verdict, the agent it runs as and the person's active agents — and every
 * verb answers the same shape, so a mutation writes its answer into this one cache entry and the
 * shell's intercept, the page and the agents table read the same thing.
 */

export type Setup = Jsonified<SetupOutput>;
export type SetupStateData = Jsonified<SetupState>;

export const setupKeys = {
  current: ["setup"] as const,
  vendors: ["setup", "vendors"] as const,
  goal: ["setup", "goal"] as const,
};

export const setupQuery = queryOptions({
  queryKey: setupKeys.current,
  queryFn: () => api<SetupStateData>("/setup"),
});

/** The body is the server's own shape (`SetupStartBody`). */
export function startSetup(body: SetupStartBody) {
  return api<SetupStateData>("/setup/start", { method: "POST", body });
}

export function skipSetup() {
  return api<SetupStateData>("/setup/skip", { method: "POST" });
}

/** One line of the vendor step: a starter, the provider that covers it here, and what connecting takes. */
export type SetupVendor = Jsonified<SetupVendorOption>;

/**
 * The vendor step's list for this deployment (`GET /api/setup/vendors`), filtered and ordered by the
 * server from the providers it has: the console never computes coverage. Under `["setup"]` so the
 * list is refetched whenever the state is invalidated.
 */
export const setupVendorsQuery = queryOptions({
  queryKey: setupKeys.vendors,
  queryFn: () => api<{ vendors: SetupVendor[] }>("/setup/vendors"),
  staleTime: 60_000,
});

/** A starter by its id, or the connection *Another vendor*'s form made (`SetupConnectBody`). */
export function connectSetup(body: SetupConnectBody) {
  return api<SetupStateData>("/setup/connect", { method: "POST", body });
}

export type SetupGoal = Jsonified<SetupGoalContext>;

/**
 * What the goal step draws (`GET /api/setup/goal`): the connection, the starter's curated goal
 * (empty for another vendor), and whether Build is available here at all, with the sentence
 * naming what the operator sets when it is not. Under `["setup"]`, so it is refetched with the
 * state.
 */
export const setupGoalQuery = queryOptions({
  queryKey: setupKeys.goal,
  queryFn: () => api<SetupGoal>("/setup/goal"),
});

export type SetupGoalSuggestionList = Jsonified<SetupGoalSuggestions>;

/**
 * The goal step's chips (`GET /api/setup/goal/suggestions`, GRA-209): up to three read-only goals
 * the deployment's model proposes for the connection, or none. A model call, so it is keyed by the
 * connection outside `["setup"]` and never refetched with the state. A failed read answers none
 * rather than an error, as a failed proposal does on the server: the chips are a convenience, so
 * they raise no toast and the step never waits on them.
 */
export function setupGoalSuggestionsQuery(connectionId: string) {
  return queryOptions({
    queryKey: ["setup-goal-suggestions", connectionId] as const,
    queryFn: (): Promise<SetupGoalSuggestionList> =>
      api<SetupGoalSuggestionList>("/setup/goal/suggestions").catch(() => ({ suggestions: [] })),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * The goal the person last pressed Build with, held in the cache alone (never fetched), so *Change
 * the goal* returns to what they typed rather than to the curated one. A reload forgets it, and
 * the curated goal is what the field then shows.
 */
export const setupGoalDraftKey = ["setup-goal-draft"] as const;

/** Build: the build approval, the job, and the record on the building step (`SetupBuildBody`). */
export function buildSetup(body: SetupBuildBody) {
  return api<SetupStateData>("/setup/build", { method: "POST", body });
}

/** *Change the goal*, once the job failed: back to the goal step. */
export function retrySetupGoal() {
  return api<SetupStateData>("/setup/goal", { method: "POST" });
}

/** *Continue while it builds*: on to the finish step with the job still running. */
export function continueSetupBuild() {
  return api<SetupStateData>("/setup/continue", { method: "POST" });
}

/** One acquire job as the agent's job route answers it: `acquire_status`'s shape. */
export type AcquireJobStatus = Jsonified<AcquireStatus>;

/** `GET /api/agents/:id/acquire-jobs/:jobId`, read at once; the building step polls it. */
export function acquireJobQuery(agentId: string, jobId: string) {
  return queryOptions({
    queryKey: ["agents", agentId, "acquire-jobs", jobId] as const,
    queryFn: () => api<AcquireJobStatus>(`/agents/${agentId}/acquire-jobs/${jobId}`),
  });
}
