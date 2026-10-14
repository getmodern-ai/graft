import type { ToolboxTool } from "./connection-queries";

/**
 * A toolbox tool's version history as the connections screen draws it (ADR 0025; GRA-242): one
 * line per version, newest first, saying where the version came from. Person-facing copy says
 * *ready-made* for stock (CONTEXT.md, *Stock tool*), and a version the person's agent published is
 * its own, so a remix reads as a ready-made line under one the agent wrote.
 */

export type ToolVersionLine = {
  id: string;
  /** `v2`. */
  label: string;
  /** Where it came from: `Ready-made v3`, `Ready-made`, or `Written by your agent`. */
  origin: string;
  current: boolean;
};

export function versionOrigin(version: ToolboxTool["versions"][number]): string {
  if (version.origin === "agent") return "Written by your agent";
  return version.stockVersionNumber === null
    ? "Ready-made"
    : `Ready-made v${version.stockVersionNumber}`;
}

export function toolVersionLines(tool: Pick<ToolboxTool, "versions">): ToolVersionLine[] {
  return [...tool.versions]
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map((version) => ({
      id: version.id,
      label: `v${version.versionNumber}`,
      origin: versionOrigin(version),
      current: version.current,
    }));
}
