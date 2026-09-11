import { CodeBlock } from "@/components/code-block";
import { KeyIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { exportTokenLine, mcpServersSnippet, TOKEN_ENV_VAR } from "@/lib/mcp-snippet";

/**
 * The one view of an agent's token (ADR 0007: the row stores a hash and a prefix, so this is the
 * only time anyone sees it). Beside it, what to do with it: the `export` line that puts it in the
 * harness's environment and the `mcpServers` block that reads it from there — the block itself
 * carries no secret (`mcp-snippet.ts`).
 */
export function TokenOnce({ token }: { token: string }) {
  const origin = window.location.origin;
  const exportLine = exportTokenLine(token);
  const snippet = mcpServersSnippet(origin);

  return (
    // `min-w-0`: this is a grid item of `DialogContent`, and a grid track's `auto` minimum takes the
    // widest unbreakable line inside it — the `export` line below is longer than the dialog — so
    // without it the track outgrows the popup and the whole dialog scrolls sideways. At zero minimum
    // the block keeps the dialog's width and each `CodeBlock`'s `pre` scrolls on its own.
    <div className="flex min-w-0 flex-col gap-4">
      <Alert>
        <KeyIcon />
        <AlertTitle>This token is shown once</AlertTitle>
        <AlertDescription>
          Graft keeps only its hash. Copy it now; if it is lost, revoke this agent and create
          another.
        </AlertDescription>
      </Alert>

      <CodeBlock
        label="The agent's token"
        code={token}
        copyLabel="Copy token"
        hint={`Put it in the harness's environment as ${TOKEN_ENV_VAR}:`}
      />
      <CodeBlock label="In the shell that starts your harness" code={exportLine} />
      <CodeBlock
        label="In your harness's MCP configuration"
        code={snippet}
        hint={`The harness expands \${${TOKEN_ENV_VAR}} from its environment, so this block holds no secret and can live in a config file you commit. Harness-specific variants are on the roadmap (GRA-27).`}
      />
    </div>
  );
}
