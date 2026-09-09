import { Snippet } from "@/components/agent/token-once";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Agent } from "@/lib/agent-queries";
import { mcpServersSnippet, TOKEN_ENV_VAR } from "@/lib/mcp-snippet";

/**
 * The connection instructions on an agent's page, after creation: the block to paste and the
 * reminder that the token is not here. A second view of the agent shows no token (ADR 0007); the
 * prefix is what tells two apart.
 */
export function HarnessSnippet({ agent }: { agent: Agent }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a harness</CardTitle>
        <CardDescription>
          The token <code className="font-mono">{agent.tokenPrefix}…</code> was shown once, when
          this agent was created, and Graft keeps only its hash. The block reads it from{" "}
          <code className="font-mono">{TOKEN_ENV_VAR}</code>. If the token is lost, revoke this
          agent and create another.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Snippet
          label="mcpServers"
          code={mcpServersSnippet(window.location.origin)}
          copyLabel="Copy"
        />
      </CardContent>
    </Card>
  );
}
