import {
  listSuggestedConnectionAsks,
  type SuggestedConnectionAskRow,
} from "@graft/db/repo/pending-action";

import type { ServiceContext } from "../context";
import type { Principal } from "../tenancy";
import type { IntegrationDirectory } from "./directory";

/**
 * **"Your agents asked for these"** (ADR 0001 as amended 2026-10-14; GRA-305): the integrations one
 * of the person's agents asked to connect that the person has not connected, for the console's
 * Integrations screen, its search and its home page. Read only from the person's own `connection`
 * asks (open, declined or expired), one per vendor, the newest ask deciding; never from what an
 * agent was told in a chat, which Graft never sees, nor from anyone else's. The mark is the
 * directory's when it has one, so the open form's starter directory answers none.
 */

/** Where the ask that suggests it stands. */
export type SuggestedAskState = "open" | "declined" | "expired";

export type SuggestedIntegration = {
  /** The vendor slug the ask proposed. */
  vendor: string;
  displayName: string;
  /** The documentation the agent's model read for the proposal, or null. */
  docsUrl: string | null;
  /** The directory entry's mark, or null where the directory has none or no entry. */
  logoUrl: string | null;
  agent: { id: string; name: string };
  ask: {
    pendingActionId: string;
    state: SuggestedAskState;
    askedAt: Date;
    /** Seconds from the ask to the read, on the server's clock. */
    ageSeconds: number;
  };
};

/** How many the read answers at most. */
export const SUGGESTED_INTEGRATIONS_LIMIT = 12;

export type SuggestedIntegrationDeps = {
  listSuggestedConnectionAsks: typeof listSuggestedConnectionAsks;
  now: () => Date;
};

export const defaultSuggestedIntegrationDeps: SuggestedIntegrationDeps = {
  listSuggestedConnectionAsks,
  now: () => new Date(),
};

/**
 * The ask's state off its clocks, as `ask_status` reads one: answered (here never with a
 * connection, which the repo left out) is declined; unanswered and consumed, which is a revoke's
 * closing, or past its expiry is expired; the rest is open.
 */
export function suggestedAskState(row: SuggestedConnectionAskRow, now: Date): SuggestedAskState {
  if (row.answeredAt) return "declined";
  if (row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "open";
}

/**
 * How long the read waits for the directory's marks (Greptile on #236): the suggestions are the
 * database's, and a slow catalogue must not hold them back, so a mark not in by then is null.
 */
export const SUGGESTED_LOGO_TIMEOUT_MS = 1_500;

async function logoOf(
  directory: IntegrationDirectory | null,
  vendor: string,
  deadline: Promise<null>,
) {
  if (!directory) return null;
  try {
    const lookup = directory.get(vendor).then((entry) => entry?.logoUrl ?? null);
    return await Promise.race([lookup, deadline]);
  } catch {
    // A mark is decoration: a directory that cannot answer leaves the suggestion without one.
    return null;
  }
}

export async function listSuggestedIntegrations(
  ctx: ServiceContext,
  principal: Principal,
  directory: IntegrationDirectory | null,
  deps: SuggestedIntegrationDeps,
): Promise<SuggestedIntegration[]> {
  const rows = await deps.listSuggestedConnectionAsks(
    ctx.db,
    principal.personId,
    SUGGESTED_INTEGRATIONS_LIMIT,
  );
  const now = deps.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SUGGESTED_LOGO_TIMEOUT_MS);
  });
  const logos = await Promise.all(
    rows.map((row) => logoOf(directory, row.vendor, deadline)),
  ).finally(() => clearTimeout(timer));
  return rows.map((row, index) => ({
    vendor: row.vendor,
    displayName: row.displayName?.trim() || row.vendor,
    docsUrl: row.docsUrl || null,
    logoUrl: logos[index] ?? null,
    agent: { id: row.agentId, name: row.agentName },
    ask: {
      pendingActionId: row.id,
      state: suggestedAskState(row, now),
      askedAt: row.createdAt,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / 1000)),
    },
  }));
}
