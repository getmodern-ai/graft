import type { AnswerAskAnswer } from "./shape";

/**
 * The handoff page's words and choices, as the card draws them (GRA-316): the card answers the
 * same asks as the page an agent links to (GRA-314), so it asks the same question with the same
 * choices. **Import-free on purpose**, as `shape.ts` is: the card is one inlined page and cannot
 * import the console. Each export is a copy of a console helper, named the same, and
 * `apps/web/src/lib/ask-card-copy.test.ts` pins every one against its original, so the two cannot
 * drift without a red test:
 *
 * - `accessOptions`, `accessLegend`, `DEFAULT_ACCESS_CHOICE`: `apps/web/src/lib/access-choice.ts`.
 * - `toolLabel`, `toolAllowOptions`, `defaultToolAllowChoice`, and `toolAllowAnswer` less the
 *   ask-every-call tick, which stays on the console (ADR 0006 as amended 2026-09-19):
 *   `apps/web/src/lib/tool-allow-choice.ts`.
 * - `proposalLead`, `proposalSummary`: `apps/web/src/lib/handoff-copy.ts`.
 */

/** *Full access* or *Ask me first* (ADR 0008 as amended 2026-10-14). */
export type AccessChoice = "full" | "ask";

export const DEFAULT_ACCESS_CHOICE: AccessChoice = "full";

export type ChoiceOption<V extends string> = {
  value: V;
  title: string;
  description: string;
  recommended: boolean;
};

export function accessOptions(
  agentName: string,
  integrationName: string,
): ChoiceOption<AccessChoice>[] {
  return [
    {
      value: "full",
      title: "Full access",
      description: `${agentName} can build ${integrationName} tools and run them without asking. Tools that can delete still ask.`,
      recommended: true,
    },
    {
      value: "ask",
      title: "Ask me first",
      description: `${agentName} asks before it builds a tool, and the first time a tool that changes data runs.`,
      recommended: false,
    },
  ];
}

export function accessLegend(agentName: string): string {
  return `What can ${agentName} do with it?`;
}

/** How much a tool's ask allows; there is no allow for one call (ADR 0008 as amended 2026-10-14). */
export type ToolAllowChoice = "integration" | "tool" | "integration-destructive";

export function toolLabel(toolName: string, vendor: string): string {
  const prefix = `${vendor}__`;
  const bare = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
  const words = bare.replace(/[_-]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : toolName;
}

/**
 * The tool ask's choices: *Every <integration> tool* first and recommended on a tool that cannot
 * delete; on a destructive tool *Just <tool>* first and the narrower integration line never, since
 * it would not cover the tool asked about.
 */
export function toolAllowOptions(input: {
  agentName: string;
  integrationName: string;
  tool: string;
  destructive: boolean;
}): ChoiceOption<ToolAllowChoice>[] {
  const { agentName, integrationName, tool, destructive } = input;
  const integration: ChoiceOption<ToolAllowChoice> = {
    value: "integration",
    title: `Every ${integrationName} tool`,
    description: `${agentName} won't ask again for ${integrationName}. Tools that can delete still ask.`,
    recommended: true,
  };
  const just: ChoiceOption<ToolAllowChoice> = {
    value: "tool",
    title: `Just ${tool}`,
    description: `${agentName} won't ask again for this tool.`,
    recommended: false,
  };
  const everything: ChoiceOption<ToolAllowChoice> = {
    value: "integration-destructive",
    title: `Every ${integrationName} tool, including ones that delete`,
    description: `${agentName} won't ask again for any ${integrationName} tool, even one that deletes data.`,
    recommended: false,
  };
  return destructive ? [just, everything] : [integration, just, everything];
}

export function defaultToolAllowChoice(destructive: boolean): ToolAllowChoice {
  return destructive ? "tool" : "integration";
}

/** What `answer_ask` is sent for a choice: the tool's own allow rides every one. */
export function toolAllowAnswer(choice: ToolAllowChoice): AnswerAskAnswer {
  if (choice === "tool") return { allow: true };
  return {
    allow: true,
    allowVendor: true,
    includesDestructive: choice === "integration-destructive",
  };
}

const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** What the person does to finish a connection, by how it signs in. */
export type ProposalFinish = "key" | "consent" | "link" | "keyless" | "widen";

/** The line under a connection's question: who set the proposal up and what is left to do. */
export function proposalLead(input: {
  agentName: string;
  integrationName: string;
  docsUrl: string | null;
  finish: ProposalFinish;
  provider?: string;
  addedHosts?: readonly string[];
}): string {
  const { agentName, integrationName, docsUrl, finish } = input;
  if (finish === "widen") {
    return `${agentName} needs ${integrationName} to reach ${(input.addedHosts ?? []).join(", ")} as well. No key is involved.`;
  }
  const from = docsUrl ? ` from ${possessive(integrationName)} docs` : "";
  const then: Record<Exclude<ProposalFinish, "widen">, string> = {
    key: `Add your ${integrationName} key to finish.`,
    consent: `Sign in to ${integrationName} to finish.`,
    link: `Sign in to ${integrationName} through ${input.provider ?? "the provider"} to finish.`,
    keyless: "It needs no key.",
  };
  return `${agentName} set this up${from}. ${then[finish]}`;
}

/**
 * The muted line above *Details*: where the connection goes, how it signs in and where the
 * proposal came from. `schemeLabel` is the card's copy of the console's `SCHEME_LABELS`.
 */
export function proposalSummary(input: {
  primaryHost: string;
  scheme: string;
  integrationName: string;
  docsUrl: string | null;
  provider?: string;
  schemeLabel: (scheme: string) => string;
}): string {
  const how = input.provider
    ? `signs in through ${input.provider}`
    : input.schemeLabel(input.scheme);
  return [
    hostOf(input.primaryHost),
    how,
    input.docsUrl ? `from ${possessive(input.integrationName)} docs` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
