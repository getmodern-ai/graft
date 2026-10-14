import type { Agent } from "./agent-queries";
import { count } from "./format";

/**
 * The agent page's Advanced card (GRA-326; Figma 2047:7614), in the person's words: ADR 0009's two
 * knobs and how the agent signs in (ADR 0018). Each sentence says what holds now; the edit is
 * `LimitsForm`'s, and the sweep is what applies it.
 */

/** "Up to 20 at once. Claude currently has 4." The count is left off until the working set lands. */
export function toolsKeptReadyLine(
  agent: Pick<Agent, "name" | "workingSetCap">,
  workingSetCount: number | null,
): string {
  const cap = `Up to ${agent.workingSetCap} at once.`;
  if (workingSetCount === null) return cap;
  return `${cap} ${agent.name} currently has ${workingSetCount}.`;
}

/** "Put away after 21 days without use. They come back when needed." */
export function unusedToolsLine(agent: Pick<Agent, "idleWindowDays">): string {
  return `Put away after ${count(agent.idleWindowDays, "day")} without use. They come back when needed.`;
}

/**
 * How the agent signs in, honest per kind (GRA-287 item 5): through the MCP client that connected
 * it, by its static token, both, or not yet; and once revoked, that it no longer does, since a
 * revoke refuses every token it held (ADR 0007). The token is named by its prefix alone; the whole
 * token was shown once and is not held.
 */
export type AgentSignIn =
  | { kind: "oauth"; clientName: string; tokenPrefix: string | null }
  | { kind: "token"; tokenPrefix: string }
  | { kind: "none" }
  | { kind: "revoked" };

export function agentSignInOf(
  agent: Pick<Agent, "connectedVia" | "tokenPrefix" | "revokedAt">,
): AgentSignIn {
  if (agent.revokedAt !== null) return { kind: "revoked" };
  if (agent.connectedVia) {
    return {
      kind: "oauth",
      clientName: agent.connectedVia.clientName,
      tokenPrefix: agent.tokenPrefix,
    };
  }
  if (agent.tokenPrefix) return { kind: "token", tokenPrefix: agent.tokenPrefix };
  return { kind: "none" };
}

export function agentSignInLine(signIn: AgentSignIn): string {
  switch (signIn.kind) {
    case "oauth":
      return signIn.tokenPrefix
        ? `Signs in through ${signIn.clientName} with OAuth, and with the token ${signIn.tokenPrefix}…`
        : `Signs in through ${signIn.clientName} with OAuth.`;
    case "token":
      return `Signs in with the token ${signIn.tokenPrefix}…`;
    case "none":
      return "Not signed in yet. Connect an agent to sign it in.";
    case "revoked":
      return "Revoked. Every token it held is refused.";
  }
}
