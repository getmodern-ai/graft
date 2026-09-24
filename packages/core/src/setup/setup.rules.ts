import type { SetupStep } from "@graft/db/schema/setup";

/**
 * Setup's rules (CONTEXT.md, *Setup*; ADR 0024), **browser-safe**: the console's shell applies the
 * show rule on entry and the agents table draws the awaiting-harness state from the predicate,
 * while the server answers the same verdicts on `GET /api/setup`. Nothing here imports more than a
 * type, so one rule has two readers and cannot disagree with itself.
 *
 * Every function takes the fields it reads and nothing else, typed so that a server `Date` and the
 * wire's string both fit: the console holds `Jsonified` shapes, the server holds rows.
 */

export type { SetupStep };

/** Where the console's Setup page lives; the shell sends a person here when `shouldShowSetup` says so. */
export const SETUP_PATH = "/setup";

/** The steps in the order they are walked, `completed` after the last (`@graft/db/schema/setup`). */
export const SETUP_STEPS = [
  "harness",
  "vendor",
  "connect",
  "goal",
  "building",
  "result",
  "finish",
  "completed",
] as const satisfies readonly SetupStep[];

type At = Date | string | null;

/** The record's three clocks, which are all the show rule reads of it. */
export type SetupClocks = { startedAt: At; completedAt: At; skippedAt: At };

/** Work the person has done by hand, counted by the server (`countSetupWork` in `@graft/db`). */
export type SetupWorkCounts = { connections: number; tools: number };

/**
 * Whether the console sends the person to Setup (GRA-202, *When the console shows Setup*): never
 * once it is completed or skipped; never when it has not started and the person already has a
 * connection or an authored tool, since work done by hand is respected (user story 29); otherwise
 * yes. A record that exists but never started (`startedAt` null) is read as no record: only a
 * skip writes one before the start does, and a skip already answers no.
 */
export function shouldShowSetup(setup: SetupClocks | null, work: SetupWorkCounts): boolean {
  if (setup?.completedAt || setup?.skippedAt) return false;
  const started = Boolean(setup?.startedAt);
  if (!started && (work.connections > 0 || work.tools > 0)) return false;
  return true;
}

/** The fields of an agent (`AgentOutput`, or its wire form) the predicate reads. */
export type AgentHarnessFields = {
  revokedAt: At;
  tokenPrefix: string | null;
  connectedVia: object | null;
};

/**
 * An agent **awaiting its harness** (CONTEXT.md, *Agent*; ADR 0024): active, with no static token
 * and no client recorded — the agent Setup minted before any harness reached it. A state read off
 * the row, never a column: it ends when a consent names the agent (`connectedVia` set) or a token
 * is issued to it (`tokenPrefix` set; the prefix is written with the hash and never without it).
 */
export function isAwaitingHarness(agent: AgentHarnessFields): boolean {
  return agent.revokedAt === null && agent.tokenPrefix === null && agent.connectedVia === null;
}

/**
 * The step the person is on: the record's, once it runs as an agent that still stands; the harness
 * step before that, or when that agent has since been revoked or deleted, so the next start mints
 * or adopts another. A completed record stays completed whatever became of its agent.
 */
export function currentSetupStep(
  setup: { step: SetupStep; agentId: string | null } | null,
  agentActive: boolean,
): SetupStep {
  if (!setup) return "harness";
  if (setup.step === "completed") return "completed";
  if (!setup.agentId || !agentActive) return "harness";
  return setup.step;
}
