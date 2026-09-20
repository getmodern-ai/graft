import { AgentDetailsSection } from "@/components/agent/agent-details-section";
import { CodeBlock } from "@/components/code-block";
import type { Agent } from "@/lib/agent-queries";
import { mcpServersSnippet, TOKEN_ENV_VAR } from "@/lib/mcp-snippet";

/**
 * The connection instructions on an agent's page, after creation: the block to paste and the
 * reminder that the token is not here. A second view of the agent shows no token (ADR 0007); the
 * prefix is what tells two apart.
 *
 * An agent an MCP client minted holds no static token (ADR 0018), so there is nothing to paste:
 * the card says who holds the tokens and that revoking the agent is how the connection ends.
 */
export function HarnessSnippet({ agent }: { agent: Agent }) {
  if (agent.tokenPrefix === null) {
    const client = agent.connectedVia?.clientName ?? "An MCP client";
    return (
      <AgentDetailsSection title={<>Connected from {client}</>}>
        <p className="text-muted-foreground text-sm">
          {client} connected over OAuth and holds this agent's tokens, refreshing them itself; there
          is nothing to paste into a config. Every call it makes is this agent: its scope, its
          working set, its approvals. Revoke the agent to end the connection. {client} will then ask
          you to connect again.
        </p>
      </AgentDetailsSection>
    );
  }
  return (
    <AgentDetailsSection
      title="Connect a harness"
      description={
        <>
          The token <code className="font-mono">{agent.tokenPrefix}…</code> was shown once, when
          this agent was created, and Graft keeps only its hash. The block reads it from{" "}
          <code className="font-mono">{TOKEN_ENV_VAR}</code>. If the token is lost, revoke this
          agent and create another.
        </>
      }
    >
      <CodeBlock label="mcpServers" code={mcpServersSnippet(window.location.origin)} />
    </AgentDetailsSection>
  );
}
