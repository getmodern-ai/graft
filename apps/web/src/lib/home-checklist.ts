import { isAwaitingHarness } from "@graft/core/setup/setup.rules";
import type { SetupPromptHarness } from "@graft/core/setup/setup-prompt";

import { connectAgentTarget, groupAgents } from "./agent-cards";
import type { AgentListItem } from "./agent-queries";
import type { Integration } from "./integration-queries";
import { promptHarnessOfClient } from "./setup-prompt-harness";
import type { SetupStateData, SetupVendor } from "./setup-queries";

/**
 * Home's *Get started* checklist (GRA-328; Figma 2099:10107), as pure decisions over reads Home
 * already makes: which of the three steps are done, which view Home draws, what each step's action
 * does, and the *Good first integrations* tiles. A person meets it after skipping Setup, since
 * `shouldShowSetup` sends everyone else to `/setup`; nothing here reads the skip, so a person who
 * did the work by hand, or whose agents are all revoked since, is told the same truth.
 */

export type HomeChecklistStepId = "agent" | "integration" | "ask";

export type HomeChecklistStep = {
  id: HomeChecklistStepId;
  done: boolean;
  /** The first step not done draws its action as the primary button, the rest as outline. */
  primary: boolean;
};

export type HomeChecklist = {
  steps: HomeChecklistStep[];
  /** How many are done, for "1 of 3 done". */
  done: number;
  total: number;
};

type ChecklistAgent = Pick<AgentListItem, "revokedAt" | "tokenPrefix" | "connectedVia">;

/**
 * The three steps: an active agent whose software is connected (one awaiting it, ADR 0024, is not
 * yet anyone's agent); any live connection (the integrations read lists nothing revoked); and any
 * agent of the person's, revoked ones included, having run a tool that answered, since asking has
 * then been done (`GET /api/agents`' `hasRunTool`, GRA-290).
 */
export function homeChecklist({
  agents,
  hasRunTool,
  integrations,
}: {
  agents: readonly ChecklistAgent[];
  hasRunTool: boolean;
  integrations: readonly unknown[];
}): HomeChecklist {
  const done: Record<HomeChecklistStepId, boolean> = {
    agent: groupAgents(agents).active.some((agent) => !isAwaitingHarness(agent)),
    integration: integrations.length > 0,
    ask: hasRunTool,
  };
  const ids: HomeChecklistStepId[] = ["agent", "integration", "ask"];
  const firstOpen = ids.find((id) => !done[id]);
  return {
    steps: ids.map((id) => ({ id, done: done[id], primary: id === firstOpen })),
    done: ids.filter((id) => done[id]).length,
    total: ids.length,
  };
}

/**
 * Which Home is drawn. `home`, the panels, once every step is done, and while either read is
 * pending or has failed, since the panels own those states (GRA-47) and a returning person should
 * not see the checklist flash. `start`, the empty Home of the frame, with none done: the checklist
 * and *What you'll see here* in place of the panels, which would each say they are empty.
 * `partial`, some done: the checklist above the panels, which now have something to show.
 */
export type HomeView = "home" | "start" | "partial";

export function homeView(checklist: HomeChecklist | null): HomeView {
  if (!checklist || checklist.done === checklist.total) return "home";
  return checklist.done === 0 ? "start" : "partial";
}

/** "0 of 3 done". */
export function checklistProgress(checklist: Pick<HomeChecklist, "done" | "total">): string {
  return `${checklist.done} of ${checklist.total} done`;
}

/**
 * The agent step's action: the create dialog, or, for an agent already made and awaiting its
 * software, where that agent is connected from (`connectAgentTarget`: Setup when it is the agent
 * an unfinished Setup runs as, else *Connect an agent*), so a second agent is not made beside it.
 */
export type AgentStepAction =
  | { kind: "create" }
  | { kind: "setup"; agentId: string }
  | { kind: "dialog"; agent: AgentListItem };

export function agentStepAction(
  agents: readonly AgentListItem[],
  setup: Pick<SetupStateData, "setup" | "agent"> | undefined,
): AgentStepAction {
  const awaiting = groupAgents(agents).active.filter((agent) => isAwaitingHarness(agent));
  const resumable = awaiting.find((agent) => connectAgentTarget(agent, setup) === "setup");
  if (resumable) return { kind: "setup", agentId: resumable.id };
  const first = awaiting[0];
  return first ? { kind: "dialog", agent: first } : { kind: "create" };
}

/**
 * Whom the ask step's setup prompt names, and which agent's words it is written in: the first
 * active agent whose software is connected, else the first awaiting it, else none, when the prompt
 * keeps "A new agent" on the consent page. The harness is the client's that consented (ADR 0018),
 * else the one Setup recorded for its own agent, else `other`, whose words fit any MCP client. The
 * connection it names is the first integration in that agent's scope, or none.
 */
export function askPromptTarget(
  agents: readonly AgentListItem[],
  setup: Pick<SetupStateData, "setup" | "agent"> | undefined,
  integrations: readonly {
    displayName: string;
    connections: readonly Pick<Integration["connections"][number], "id">[];
  }[],
): { agentName?: string; harness: SetupPromptHarness; connection?: { displayName: string } } {
  const { active } = groupAgents(agents);
  const agent = active.find((row) => !isAwaitingHarness(row)) ?? active[0];
  if (!agent) {
    // The prompt's new agent takes every connection, as a new agent's scope does (ADR 0007).
    const first = integrations[0];
    return {
      harness: setup?.setup?.harness ?? "other",
      ...(first ? { connection: { displayName: first.displayName } } : {}),
    };
  }
  const recorded = setup?.agent?.id === agent.id ? setup.setup?.harness : null;
  // An integration the agent can reach, so a `listed` agent is never told of one it cannot use.
  const scope = new Set(agent.connectionIds);
  const reachable = integrations.find((row) => row.connections.some((c) => scope.has(c.id)));
  return {
    agentName: agent.name,
    harness: agent.connectedVia
      ? promptHarnessOfClient(agent.connectedVia.clientName)
      : (recorded ?? "other"),
    ...(reachable ? { connection: { displayName: reachable.displayName } } : {}),
  };
}

/**
 * Whether the checklist offers *Resume Setup*: a Setup the person skipped and never completed
 * (ADR 0024: every step of it is one the console also offers on its own, so it is an offer, never
 * the way). Opening `/setup` resumes it, and its start clears the skip.
 */
export function offersResumeSetup(setup: Pick<SetupStateData, "setup"> | undefined): boolean {
  return Boolean(setup?.setup?.skippedAt && !setup.setup.completedAt);
}

/** Tiles *Good first integrations* draws, one row of them at full width. */
export const GOOD_FIRST_TILES = 4;
/** Marks the integration step shows under its sentence. */
export const INTEGRATION_STEP_MARKS = 7;

/**
 * The starters this deployment connects (`GET /api/setup/vendors`, in the server's order: a link
 * provider's first), less any the person has connected. They are Setup's starters and nothing
 * else, each with its curated task, which is what keeps this within ADR 0001 with no catalogue.
 */
export function goodFirstIntegrations(
  vendors: readonly SetupVendor[],
  integrations: readonly Pick<Integration, "vendor">[],
): SetupVendor[] {
  const connected = new Set(integrations.map((row) => row.vendor));
  return vendors.filter((option) => !connected.has(option.starter.vendor));
}

/** A tile's line: the starter's curated task, which a person can say to their agent as it is. */
export function tryLine(starter: Pick<SetupVendor["starter"], "goal">): string {
  return `Try: "${starter.goal}"`;
}
