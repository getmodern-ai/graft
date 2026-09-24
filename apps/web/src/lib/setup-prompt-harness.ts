import type { SetupPromptHarness } from "@graft/core/setup/setup-prompt";

import type { Harness } from "./mcp-snippet";

/**
 * Which setup prompt (`@graft/core`'s `setupPrompt`, GRA-205) the console shows for an agent. The
 * prompt knows seven harnesses; the console's configuration blocks know three shapes, so a
 * static-token agent's prompt follows the shape the person picked, and an OAuth agent's follows the
 * client that consented for it, read off the name it registered (ADR 0018), since that is the one
 * fact the console holds about which harness runs the agent.
 */

/** The prompt for the configuration shape the person picked; any other MCP client is `other`. */
export function promptHarnessOfShape(shape: Harness): SetupPromptHarness {
  return shape === "generic" ? "other" : shape;
}

/**
 * The prompt for an OAuth agent's client, by the name it registered: Claude Code and Codex before
 * the chat products whose names they contain. A name none of them matches, or none at all (an
 * agent awaiting its harness), is `other`, whose prompt works for any MCP client.
 */
export function promptHarnessOfClient(clientName: string | null | undefined): SetupPromptHarness {
  const name = (clientName ?? "").toLowerCase();
  if (name.includes("claude code") || name.includes("claude-code")) return "claude-code";
  if (name.includes("codex")) return "codex";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("claude")) return "claude";
  if (name.includes("hermes")) return "hermes";
  if (name.includes("openclaw")) return "openclaw";
  return "other";
}
