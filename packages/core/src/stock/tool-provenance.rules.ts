import type { StockLineage } from "./stock-advance.decision";

/**
 * **Where a tool came from, as its ask says it** (ADR 0008 as amended 2026-10-09; GRA-245). One
 * source for the three places a tool's ask is drawn: the console's pending card reads it off the
 * payload's `provenance`, the MCP server writes it into the ask card's data and the elicitation
 * form's message (`@graft/mcp`'s `approval.ts`). Browser-safe: imports a type and nothing else.
 *
 * The kind is the tool's lineage (`stockLineageOf`): a `stock` copy was reviewed before release
 * and its description is Graft's; a `remix` and an `authored` tool carry a description the agent's
 * model wrote, which the person should read as the agent's account rather than anyone's promise.
 */

export type ToolProvenance = {
  kind: StockLineage;
  /** The short mark beside the description, on the console's card and the ask card. */
  badge: string;
  /** The sentence beside the mark. */
  note: string;
  /** What introduces the quoted description in the elicitation form's message. */
  descriptionLead: string;
};

const PROVENANCE: Record<StockLineage, ToolProvenance> = {
  stock: {
    kind: "stock",
    badge: "Ready-made by Graft",
    note: "Ready-made by Graft and reviewed before release.",
    descriptionLead: "Ready-made by Graft and reviewed before release. Its description:",
  },
  remix: {
    kind: "remix",
    badge: "written by the agent's model",
    note: "Your agent's version of a ready-made tool; its description was written by your agent's model.",
    descriptionLead:
      "Your agent's version of a ready-made tool. Its description, in your agent's model's own words:",
  },
  authored: {
    kind: "authored",
    badge: "written by the agent's model",
    note: "This tool's description was written by the agent's model, not by a person. Read it as the agent's account of what the tool does.",
    descriptionLead: "Its description, in the agent's model's own words:",
  },
};

/**
 * The provenance of a kind. Anything but `stock` or `remix` reads as `authored`, so an ask written
 * before the kind was recorded on its payload is drawn as it always was.
 */
export function toolProvenance(kind: unknown): ToolProvenance {
  return kind === "stock" || kind === "remix" ? PROVENANCE[kind] : PROVENANCE.authored;
}
