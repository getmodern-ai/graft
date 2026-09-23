import type { SetupOutput, SetupState, SetupVendorOption } from "@graft/core";
import type { SetupConnectBody, SetupStartBody } from "@graft/server/api";
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
