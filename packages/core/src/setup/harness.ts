import type { SetupHarness } from "@graft/db/schema/setup";

/**
 * The harnesses Setup offers at its first step (CONTEXT.md, *Harness*; GRA-202, user story 3), as
 * data: one entry per harness and nothing else to edit to add one. **Browser-safe**: the console
 * renders the step from this module and the server holds a start to its ids, so it imports nothing
 * but a type. It is also the setup prompt's list (`setup-prompt.ts`, GRA-205, reconciled onto this
 * one under GRA-208), which `GET /api/setup-prompt` answers as `{ id, label, description }`: the
 * ids are that route's public contract and the marketing site's.
 *
 * `kind` is how the harness reaches Graft: `oauth`, a client that registers itself and consents
 * (ADR 0018), so Setup's finish step shows the connector URL and the consent steps and never mints
 * a token; or `token`, a static bearer the person pastes into the harness's configuration, minted
 * at the finish step (ADR 0024). The label and the one line under it are the marketing site's
 * seven-harness picker's (`graft-marketing`'s `src/lib/setup-prompt.ts`), in its order, so a person
 * who arrives from "Try for free" recognises the list. `agentName` is what the agent is called
 * when the person does not name it under *Advanced options*.
 *
 * `steps` are the harness's connection instructions as the finish step lists them (GRA-208): for
 * an `oauth` harness, how to add Graft's MCP server URL in that product, with the consent step
 * after them the finish step's own (it names the agent); for a `token` harness, where the token
 * and the configuration go, beside the blocks the create dialog draws. Short sentences a person
 * follows with the product open; the setup prompt carries the long form for the harness's model.
 */
export type SetupHarnessKind = "oauth" | "token";

export type SetupHarnessEntry = {
  id: SetupHarness;
  label: string;
  description: string;
  kind: SetupHarnessKind;
  agentName: string;
  steps: readonly string[];
};

export type { SetupHarness };

export const SETUP_HARNESSES = [
  {
    id: "claude",
    label: "Claude",
    description: "Web & desktop",
    kind: "oauth",
    agentName: "Claude",
    steps: [
      "In Claude, open Customize, then Connectors, and choose Add custom connector (older versions keep Connectors under Settings).",
      "Name it Graft, paste the MCP server URL, leave the OAuth client ID and secret empty, then choose Add and Connect.",
      "In a conversation, open + and then Connectors, and turn Graft on.",
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Terminal & IDE",
    kind: "oauth",
    agentName: "Claude Code",
    steps: [
      "Run claude mcp add --transport http --scope user graft with the MCP server URL after it.",
      "In Claude Code, run /mcp, select graft and choose Authenticate.",
    ],
  },
  {
    id: "codex",
    label: "Codex",
    description: "App, CLI & IDE",
    kind: "oauth",
    agentName: "Codex",
    steps: [
      "Run codex mcp add graft --url with the MCP server URL after it.",
      "If Codex does not open a sign-in page by itself, run codex mcp login graft.",
    ],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    description: "Web & desktop",
    kind: "oauth",
    agentName: "ChatGPT",
    steps: [
      "In ChatGPT, open Settings, then Connectors, then Advanced settings, and turn Developer mode on.",
      "Back on Connectors, choose Create: name it Graft, paste the MCP server URL, choose OAuth, leave the client ID and secret empty, and choose Create.",
      "In a conversation, open the tools menu, choose Developer mode and select Graft.",
    ],
  },
  {
    id: "hermes",
    label: "Hermes",
    description: "Local agent",
    kind: "token",
    agentName: "Hermes",
    steps: [
      "Put the token line in ~/.hermes/.env.",
      "Add the configuration to ~/.hermes/config.yaml, then restart Hermes or run /reload-mcp.",
    ],
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    description: "Local agent",
    kind: "token",
    agentName: "OpenClaw",
    steps: [
      "Put the token line in ~/.openclaw/.env on the Gateway host.",
      "Merge the configuration into ~/.openclaw/openclaw.json, then restart the Gateway.",
    ],
  },
  {
    id: "other",
    label: "Other MCP agent",
    description: "Any compatible client",
    kind: "token",
    agentName: "MCP agent",
    steps: [
      "Set the token in the environment of the shell that starts your client.",
      "Add the configuration to your client's MCP servers, then reload the client.",
    ],
  },
] as const satisfies readonly SetupHarnessEntry[];

/** The ids in the order the step offers them. */
export const SETUP_HARNESS_IDS: readonly SetupHarness[] = SETUP_HARNESSES.map((entry) => entry.id);

/** One harness's entry by id. */
export function setupHarnessOf(id: SetupHarness): SetupHarnessEntry {
  const entry = SETUP_HARNESSES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`No setup harness named ${id}`);
  return entry;
}

/** A value read back as a harness id, or null for anything that is not one. */
export function readSetupHarness(value: unknown): SetupHarness | null {
  return SETUP_HARNESS_IDS.find((id) => id === value) ?? null;
}
