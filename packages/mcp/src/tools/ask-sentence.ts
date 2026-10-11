import { integrationNameFor } from "@graft/core";

/**
 * A connection as the card's sentences name it: its name, with the integration's beside it when
 * the two differ, and never the vendor slug (GRA-273; CONTEXT.md, *Integration*).
 */
export function connectionWords(displayName: string, vendor: string): string {
  if (!vendor) return displayName;
  const integration = integrationNameFor(vendor, displayName);
  return integration.toLowerCase() === displayName.toLowerCase()
    ? displayName
    : `${displayName} (${integration})`;
}

/**
 * What the ask card shows once a tool's first-use ask is settled (GRA-116), in the card's voice:
 * the one spelling `answer_ask` answers with and `ask_status` reads back, so the card says the
 * same thing whichever door settled the ask. A no holds as a yes does (ADR 0008 as amended
 * 2026-09-15), which is what the decline says; the console's own words are
 * `apps/web/src/lib/tool-ask-copy.ts`.
 */
export function toolAskAnsweredSentence(args: {
  agentName: string;
  /** The tool's wire name, `<vendor>__<name>`. */
  tool: string;
  allow: boolean;
  /** Whether the tool is set to ask every time, which makes a yes one call's alone. */
  askEveryCall: boolean;
}): string {
  const { agentName, tool } = args;
  if (!args.allow) {
    return `Declined. ${agentName} will not run ${tool}, and that answer holds until you change it on the agent's page in the console.`;
  }
  return args.askEveryCall
    ? `Allowed for this call. ${tool} asks again next time; turn that off on the agent's page in the console.`
    : `Allowed. ${agentName} may run ${tool}; the answer holds for its next calls until withdrawn on its page in the console.`;
}
