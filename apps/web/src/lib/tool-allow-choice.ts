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
 * separate tick that rides any of the three, as it rides the inbox card's answer. The Requests row's
 * Allow menu (`toolAllowMenuOptions`) offers the same choices without the tick.
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

/**
 * The yes the answer route takes for a choice; the tool's own allow rides every one. `askEveryCall`
 * rides only where it is given, so a door that draws no tick (the Requests row's Allow menu) never
 * touches the tool's per-call setting: the route reads an absent key as "leave it" and `false` as
 * "turn it off" (`setApproval`; ADR 0008 as amended 2026-09-15).
 */
export function toolAllowAnswer(choice: ToolAllowChoice, askEveryCall?: boolean): AnswerBody {
  const tick = askEveryCall === undefined ? {} : { askEveryCall };
  if (choice === "tool") return { allow: true, ...tick };
  return {
    allow: true,
    ...tick,
    allowVendor: true,
    includesDestructive: choice === "integration-destructive",
  };
}

/**
 * What the ask-every-call tick sends: on when ticked, off only when the setting stood on and the
 * person unticked it, nothing when it stayed off, so no answer writes a setting nobody chose.
 */
export function askEveryCallSent(ticked: boolean, standing: boolean): boolean | undefined {
  if (ticked) return true;
  return standing ? false : undefined;
}

/** The menu's heading, in the row's words: "Allow Codex to send email in Gmail". */
export function toolAllowMenuLabel(input: {
  agentName: string;
  /** `toolActionWords` of the tool's wire name; null when it reads as nothing. */
  action: string | null;
  integrationName: string;
}): string {
  const { agentName, action, integrationName } = input;
  return action
    ? `Allow ${agentName} to ${action} in ${integrationName}`
    : `Allow ${agentName} to use a ${integrationName} tool`;
}

export type ToolAllowMenuOption = {
  value: ToolAllowChoice;
  title: string;
  description: string;
  recommended: boolean;
  /** The line that reaches tools that delete, drawn in the destructive tone. */
  destructive: boolean;
};

/**
 * The Requests row's Allow menu (GRA-311; frames 2107:12561 and 2107:13052): the radio's choices in
 * the menu's shorter words, fewer of them. On a tool that cannot delete, *Every <integration> tool*
 * (recommended, destructive tools left out) and *Just <tool>*; the line that includes destructive
 * tools stays in the request dialog, read beside the rest. On a destructive tool, *Just <tool>*
 * (recommended, as `defaultToolAllowChoice` starts the radio) and the line that includes them,
 * never the narrower integration line, which would not cover the tool asked about. The recommended
 * choice is first, so the menu's keyboard highlight starts on it.
 */
export function toolAllowMenuOptions(input: {
  agentName: string;
  integrationName: string;
  tool: string;
  destructive: boolean;
}): ToolAllowMenuOption[] {
  const { agentName, integrationName, tool, destructive } = input;
  if (destructive) {
    return [
      {
        value: "tool",
        title: `Just ${tool}`,
        description: "Won't ask again for this tool. It can delete data.",
        recommended: true,
        destructive: false,
      },
      {
        value: "integration-destructive",
        title: `Every ${integrationName} tool, including ones that delete`,
        description: `${agentName} won't ask again for anything in ${integrationName}.`,
        recommended: false,
        destructive: true,
      },
    ];
  }
  return [
    {
      value: "integration",
      title: `Every ${integrationName} tool`,
      description: `Won't ask again for ${integrationName}. Tools that can delete still ask.`,
      recommended: true,
      destructive: false,
    },
    {
      value: "tool",
      title: `Just ${tool}`,
      description: "Won't ask again for this tool.",
      recommended: false,
      destructive: false,
    },
  ];
}
