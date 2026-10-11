import type { AskOrigin } from "./ask-answered-copy";

/**
 * Who a connection proposal came from, as the pending card's badge says it (GRA-273). An agent's
 * `request_connection` cannot tell a proposal its model wrote from the documentation it read from
 * one it copied out of a ready-made tool's `connect` arguments in `find_tool`'s answer, since both
 * arrive as the same call, so the badge names the agent that asked and nothing about its model.
 */
export function proposalSourceBadge(agentName: string | null): string {
  return `requested by ${agentName ?? "a revoked agent"}`;
}

/**
 * The label on a proposal's documentation link: Graft's own page for Setup's curated entry, the
 * page the agent named for any other ask, whether its model read it or a ready-made tool carried it.
 */
export function proposalDocsLabel(origin: AskOrigin): string {
  return origin === "setup"
    ? "The integration's documentation"
    : "The documentation the agent named";
}
