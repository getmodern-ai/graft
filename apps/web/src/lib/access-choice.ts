import { type ConnectionChoices, connectionChoicesSent } from "./connection-choices";

/**
 * The handoff page's *Full access / Ask me first* (GRA-314; ADR 0008 as amended 2026-10-14), in
 * place of the two pre-ticked lines the inbox's cards draw (`BuildApprovalItem`,
 * `VendorToolsItem`). *Full access* is the asking agent's build approval and its standing allow
 * for every non-destructive tool of the integration; *Ask me first* records neither, so the agent
 * asks as it always did. The build-yes, integration-no mix the two lines allowed is not offered.
 *
 * What a choice sends still goes through `connectionChoicesSent` (GRA-274): a grant the card does
 * not draw is never a yes, whatever the choice.
 */
export type AccessChoice = "full" | "ask";

/** Pre-selected, as the connection confirmation pre-ticks both lines (ADR 0008, 2026-10-09). */
export const DEFAULT_ACCESS_CHOICE: AccessChoice = "full";

export function accessChoiceSent(
  choice: AccessChoice,
  shown: ConnectionChoices,
): ConnectionChoices {
  const full = choice === "full";
  return connectionChoicesSent(shown, { approveBuild: full, allowVendor: full });
}

export type AccessOption = {
  value: AccessChoice;
  title: string;
  description: string;
  recommended: boolean;
};

/**
 * The two options' words. *Ask me first* says when the agent asks and no more: reads never ask
 * (ADR 0008), so the sentence never says it asks before it "uses" a tool.
 */
export function accessOptions(agentName: string, integrationName: string): AccessOption[] {
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

/** The question over the two options. */
export function accessLegend(agentName: string): string {
  return `What can ${agentName} do with it?`;
}
