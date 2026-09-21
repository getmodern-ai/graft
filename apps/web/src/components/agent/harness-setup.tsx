import { CodeBlock } from "@/components/code-block";
import { exportTokenLine, mcpEndpointUrl, mcpServersSnippet } from "@/lib/mcp-snippet";

/** Shared by creation and the saved-token instructions (ADR 0007). */
export function HarnessSetup({ token }: { token?: string }) {
  const origin = window.location.origin;

  return (
    <>
      <CodeBlock label="MCP server URL" code={mcpEndpointUrl(origin)} copyLabel="Copy URL" />
      <CodeBlock
        label="Set your token"
        code={exportTokenLine(token ?? "YOUR_AGENT_TOKEN")}
        copyLabel="Copy command"
        hint={
          token
            ? "Run this command in the shell that starts your harness."
            : "Replace YOUR_AGENT_TOKEN with your saved token, then run this command in the shell that starts your harness."
        }
      />
      <CodeBlock
        label="MCP configuration"
        code={mcpServersSnippet(origin)}
        copyLabel="Copy configuration"
        hint="Add this to your harness's MCP configuration. It reads your token from GRAFT_TOKEN."
      />
    </>
  );
}
