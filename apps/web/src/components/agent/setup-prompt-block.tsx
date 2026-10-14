import { type SetupPromptHarness, setupPrompt } from "@graft/core/setup/setup-prompt";

import { CodeBlock } from "@/components/code-block";
import { mcpEndpointUrl } from "@/lib/mcp-snippet";

/**
 * The setup prompt for an agent (GRA-205): the text a person pastes into the harness as their first
 * message, so the harness's model connects itself as this agent. One function writes it for the
 * console, Setup's finish step and the public route (`@graft/core`'s `setupPrompt`), so the words
 * never drift; this block gives it this deployment's URLs and the agent's name, never its token.
 * Setup's finish step (GRA-208) passes the connection and the tool too, the tool's wire name only
 * once it has landed, so the prompt says it is arriving while the build runs.
 */
export function SetupPromptBlock({
  harness,
  agentName,
  connection,
  tool,
}: {
  harness: SetupPromptHarness;
  /** Absent on Home's checklist for a person with no agent: the prompt keeps "A new agent". */
  agentName?: string;
  connection?: { displayName: string };
  tool?: { goal: string; wireName?: string };
}) {
  const origin = window.location.origin;
  const prompt = setupPrompt({
    harness,
    mcpUrl: mcpEndpointUrl(origin),
    consoleUrl: origin,
    ...(agentName ? { agent: { name: agentName } } : {}),
    ...(connection ? { connection } : {}),
    ...(tool ? { tool } : {}),
  });

  return (
    <CodeBlock
      label="Setup prompt"
      code={prompt}
      copyLabel="Copy prompt"
      wrap
      hint="Paste it into your agent as your first message. It walks the agent through connecting to Graft and holds no token."
    />
  );
}
