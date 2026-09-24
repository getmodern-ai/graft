import type { SetupOutput, SetupState } from "@graft/core";
import type { SetupStartBody } from "@graft/server/api";
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
