import { getAgent } from "@graft/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SessionContext } from "./context";
import { toolRefusal } from "./result";

/**
 * Which agents get the authoring set and the `execute__` tools (GRA-125; ADR 0004 as amended
 * 2026-09-20). The set exists for a person who drives their agent by hand — a harness under a
 * static token, Hermes or OpenClaw, where the skill's "author by hand" case lives. A chat product's
 * agent, held over OAuth (ADR 0018), gets `acquire` alone: measured live on 2026-09-20, a chat model
 * with `execute__` in its list called it for a vendor question instead of `find_tool`, and another
 * abandoned a running job to write and run its own code through `write_file` and `execute__` —
 * the person's credential under the chat model's code, which is what `acquire` exists to avoid.
 * So the list a chat product's agent sees carries neither, and a call to one is refused by name.
 *
 * The verdict is the agent row's `connected_via_client_id`, read once per session and memoised as
 * `card-client.ts` memoises the card verdict; a thrown read is not kept.
 */

const verdicts = new WeakMap<SessionContext, Promise<boolean>>();

/** True for an agent its person drives by hand — a static-token agent; false for a chat product's. */
export function agentDrivesByHand(session: SessionContext): Promise<boolean> {
  const held = verdicts.get(session);
  if (held) return held;
  const judged = (async () => {
    const { ctx, principal, scope, deps } = session;
    const agent = await getAgent(ctx, principal, scope.agentId, deps.agent);
    return !agent?.connectedVia;
  })();
  verdicts.set(session, judged);
  judged.catch(() => verdicts.delete(session));
  return judged;
}

/** The refusal word when a chat product's agent calls a tool its list does not carry. */
export const ADVANCED_TOOLS_HIDDEN = "advanced_tools_hidden";

export function hiddenToolRefusal(name: string): CallToolResult {
  return toolRefusal(
    ADVANCED_TOOLS_HIDDEN,
    `${name} is not in this agent's list: an agent connected from a chat product gets its tools through acquire, and find_tool names the connections acquire takes. The authoring tools and execute__ are for an agent driven by hand under a static token.`,
  );
}
