import type { StarterVendor } from "./starter-vendors";

/**
 * **Setup's ready-made tools** (GRA-276; ADR 0024 as amended 2026-10-11; ADR 0025), browser-safe:
 * which of an integration's stock tools the tool step offers before a task to build, and the wire
 * name a choice is saved and copied under. The server answers the list (`GET /api/setup/stock`)
 * from the catalogue it holds, and judges a choice against the same list, so the console never
 * decides what a person may take.
 *
 * The offer is the starter's curated `readyMade`, in its order, kept only where the catalogue holds
 * that stock tool and the check found it read-only: Setup's result step runs only a read-only tool,
 * and a curated entry the catalogue lacks (a release without it, a tool the check refused at boot)
 * is dropped rather than offered and refused. At most `SETUP_READY_MADE_MAX`, so the screen stays
 * one row of cards.
 */

/** How many ready-made tools the tool step offers at most. */
export const SETUP_READY_MADE_MAX = 3;

/** One stock tool as the catalogue answers it (`StockToolSummary`), the fields the offer reads. */
export type ReadyMadeCatalogueEntry = {
  name: string;
  description: string;
  annotations: { readOnly: boolean };
};

/** One ready-made tool as the tool step draws it. */
export type SetupReadyMadeTool = {
  /** The wire name, `<vendor>__<name>`: what a choice names, and what the copy keeps. */
  tool: string;
  /** The task it does, in the person's words: the card's label, and the tool's goal after. */
  goal: string;
  /** The catalogue's description, its first sentence: what the tool reads, for the line under. */
  description: string;
  /** The starter's tasks this tool does beside `goal` (`StarterReadyMade.replaces`). */
  replaces: string[];
};

/** The wire name of a vendor's tool, `<vendor>__<name>`, as `@graft/mcp`'s `authoredToolName` spells it. */
export function readyMadeWireName(vendor: string, name: string): string {
  return `${vendor}__${name}`;
}

/** A wire name read back into its vendor and name, or null when it is not one. */
export function readyMadeKey(wire: string): { vendor: string; name: string } | null {
  const at = wire.indexOf("__");
  if (at <= 0 || at + 2 >= wire.length) return null;
  return { vendor: wire.slice(0, at), name: wire.slice(at + 2) };
}

/** The text up to and including its first full stop followed by a space, or the whole text. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/\.\s/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/**
 * The ready-made tools the tool step offers for a starter, given the catalogue's tools of its
 * integration: the curated entries the catalogue holds as read-only, in the curated order, at most
 * `SETUP_READY_MADE_MAX`. None for another integration (`starter` null).
 */
export function setupReadyMade(
  starter: Pick<StarterVendor, "vendor" | "readyMade"> | null,
  catalogue: readonly ReadyMadeCatalogueEntry[],
): SetupReadyMadeTool[] {
  if (!starter) return [];
  const byName = new Map(catalogue.map((entry) => [entry.name, entry]));
  const offered: SetupReadyMadeTool[] = [];
  for (const curated of starter.readyMade) {
    const entry = byName.get(curated.tool);
    if (!entry?.annotations.readOnly) continue;
    offered.push({
      tool: readyMadeWireName(starter.vendor, curated.tool),
      goal: curated.goal,
      description: firstSentence(entry.description),
      replaces: [...(curated.replaces ?? [])],
    });
    if (offered.length === SETUP_READY_MADE_MAX) break;
  }
  return offered;
}
