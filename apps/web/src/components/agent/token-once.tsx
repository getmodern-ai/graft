import { KeyRoundIcon } from "lucide-react";

import { CopyButton } from "@/components/copy-button";
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
    <div className="flex flex-col gap-4">
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>This token is shown once</AlertTitle>
        <AlertDescription>
          Graft keeps only its hash. Copy it now; if it is lost, revoke this agent and create
          another.
        </AlertDescription>
      </Alert>

      <Snippet
        label="The agent's token"
        code={token}
        copyLabel="Copy token"
        hint={`Put it in the harness's environment as ${TOKEN_ENV_VAR}:`}
      />
      <Snippet label="In the shell that starts your harness" code={exportLine} copyLabel="Copy" />
      <Snippet
        label="In your harness's MCP configuration"
        code={snippet}
        copyLabel="Copy"
        hint={`The harness expands \${${TOKEN_ENV_VAR}} from its environment, so this block holds no secret and can live in a config file you commit. Harness-specific variants are on the roadmap (GRA-27).`}
      />
    </div>
  );
}

export function Snippet({
  label,
  code,
  copyLabel,
  hint,
}: {
  label: string;
  code: string;
  copyLabel: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{label}</span>
        <CopyButton text={code} label={copyLabel} />
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
