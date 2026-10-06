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

/**
 * The query that names the agent a Setup page opened from outside the console should run as
 * (GRA-210): `find_tool`'s offer builds it (`setupUrl`) and the console's `/setup` reads it, so
 * Setup adopts that agent even when the person has several.
 */
export const SETUP_AGENT_PARAM = "agent";

/**
 * A URL with its trailing slashes trimmed, by index rather than by a regular expression over
 * caller input: `/\/+$/` backtracks polynomially on a long run of slashes (CodeQL's
 * polynomial-regex rule, on #167). `setupUrl` and `setup-prompt.ts` read it.
 */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

/**
 * The console URL of the Setup page for one agent: `<GRAFT_CONSOLE_URL>/setup?agent=<id>`, the
 * base's own path kept and a trailing slash not doubled, as `handoffUrl` builds a handoff's.
 */
export function setupUrl(consoleUrl: string, agentId: string): string {
  const base = withoutTrailingSlashes(consoleUrl);
  const query = new URLSearchParams({ [SETUP_AGENT_PARAM]: agentId });
  return `${base}${SETUP_PATH}?${query}`;
}

/**
 * Whether `find_tool` offers Setup in the chat (GRA-210; GRA-202, *The in-chat door*): while the
 * person has no connection at all, revoked ones included as the show rule counts them, and their
 * Setup is neither completed nor skipped. A Setup under way is still offered, since the page
 * resumes where the record stands. One connection of any kind ends the offer: the agent then has
 * a vendor to ask for, and the playbook takes over.
 */
export function shouldOfferSetup(
  setup: Pick<SetupClocks, "completedAt" | "skippedAt"> | null,
  work: Pick<SetupWorkCounts, "connections">,
): boolean {
  if (setup?.completedAt || setup?.skippedAt) return false;
  return work.connections === 0;
}

/** The fields of the record the navigation rules read (`SetupOutput`, or its wire form). */
export type SetupNavigationFields = {
  step: SetupStep;
  pendingActionId: string | null;
  connectionId: string | null;
  acquireJobId: string | null;
  toolId: string | null;
};

/**
 * Whether the record holds what a step shows, so the step can be returned to (GRA-215): the harness
 * and the vendor always; the connect step once an ask or a connection is named; the goal once a
 * connection is; the building step once a job is; the result once a tool is. The finish is never a
 * step to go back to, since only `completed` lies beyond it and a completed Setup does not move.
 * The result is the one step a record passes without holding: *Continue while it runs* goes from
 * the building step straight to the finish, and the result is not there to return to until the tool
 * lands.
 */
export function setupStepReachable(
  step: SetupStep,
  record: Omit<SetupNavigationFields, "step">,
): boolean {
  switch (step) {
    case "harness":
    case "vendor":
      return true;
    case "connect":
      return record.connectionId !== null || record.pendingActionId !== null;
    case "goal":
      return record.connectionId !== null;
    case "building":
      return record.acquireJobId !== null;
    case "result":
      return record.acquireJobId !== null && record.toolId !== null;
    default:
      return false;
  }
}

/**
 * The steps the record may go back to (GRA-215, *The rail is navigable*): every step before the
 * one it stands on that it holds what for (`setupStepReachable`), in order. None on the harness
 * step and none once completed. The server's back move admits exactly these, and the console's rail
 * links exactly these beside the current step, so a step ahead is never a link.
 */
export function setupBackTargets(record: SetupNavigationFields): SetupStep[] {
  if (record.step === "completed") return [];
  const at = SETUP_STEPS.indexOf(record.step);
  return SETUP_STEPS.slice(0, at).filter((step) => setupStepReachable(step, record));
}

/** The step the footer's *Back* returns to: the nearest of `setupBackTargets`, or null on the first. */
export function previousSetupStep(record: SetupNavigationFields): SetupStep | null {
  return setupBackTargets(record).at(-1) ?? null;
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
