import type { AnswerBody } from "@graft/server/api";

/**
 * How much a tool's ask allows, on the handoff page (GRA-314; ADR 0008 as amended 2026-10-14): one
 * radio over the integration-wide allow, the tool alone, and the integration's destructive tools.
 *
 * - **Every <integration> tool**, destructive ones left out: pre-selected on a tool that cannot
 *   delete, as the connection confirmation pre-ticks the same allow.
 * - **Just <tool>**: the tool's own standing allow. Pre-selected on a destructive tool, since the
 *   amendment lets an allow cover destructive tools only when the person picks the line that says
 *   so, and the narrower integration line would not cover the tool asked about.
 * - **Every <integration> tool, including ones that delete**: the full request.
 *
 * There is no allow for one call (the same amendment cut "Just this once"); asking every call is a
 * separate tick that rides any of the three, as it rides the inbox card's answer.
 */
export type ToolAllowChoice = "integration" | "tool" | "integration-destructive";

export type ToolAllowOption = {
  value: ToolAllowChoice;
  title: string;
  description: string;
  recommended: boolean;
};

/**
 * A tool's wire name as a person reads it: the vendor's prefix off, the separators as spaces, the
 * first letter capitalised (`gmail__send-email` reads "Send email").
 */
export function toolLabel(toolName: string, vendor: string): string {
  const prefix = `${vendor}__`;
  const bare = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
  const words = bare.replace(/[_-]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : toolName;
}

export function toolAllowOptions(input: {
  agentName: string;
  integrationName: string;
  tool: string;
  destructive: boolean;
}): ToolAllowOption[] {
  const { agentName, integrationName, tool, destructive } = input;
  const integration: ToolAllowOption = {
    value: "integration",
    title: `Every ${integrationName} tool`,
    description: `${agentName} won't ask again for ${integrationName}. Tools that can delete still ask.`,
    recommended: true,
  };
  const just: ToolAllowOption = {
    value: "tool",
    title: `Just ${tool}`,
    description: `${agentName} won't ask again for this tool.`,
    recommended: false,
  };
  const everything: ToolAllowOption = {
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

/** The yes the answer route takes for a choice; the tool's own allow rides every one. */
export function toolAllowAnswer(choice: ToolAllowChoice, askEveryCall: boolean): AnswerBody {
  if (choice === "tool") return { allow: true, askEveryCall };
  return {
    allow: true,
    askEveryCall,
    allowVendor: true,
    includesDestructive: choice === "integration-destructive",
  };
}
