import { type AgentHarnessFields, isAwaitingHarness } from "@graft/core/setup/setup.rules";

/** The consent card's option that is not an agent: mint a new one, named for the client. */
export const NEW_AGENT = "new";

/**
 * The agent the consent card pre-selects (ADR 0024; ADR 0018 as amended 2026-09-23; GRA-208): the
 * person's one agent **awaiting its harness**, the agent Setup made for the harness now consenting,
 * so connecting from the chat lands on it rather than minting a second; with none, or several,
 * *A new agent*, since guessing among several is the person's call and not the default. The
 * consent service needs no change: naming an existing agent is a choice it already admits.
 */
export function consentDefaultAgent(
  agents: readonly (AgentHarnessFields & { id: string })[],
): string {
  const awaiting = agents.filter(isAwaitingHarness);
  return awaiting.length === 1 && awaiting[0] ? awaiting[0].id : NEW_AGENT;
}
