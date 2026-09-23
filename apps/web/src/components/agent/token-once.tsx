import { HarnessSetup } from "@/components/agent/harness-setup";
import { CodeBlock } from "@/components/code-block";
import { KeyIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * The one view of an agent's token (ADR 0007: the row stores a hash and a prefix, so this is the
 * only time anyone sees it). Beside it, what to do with it: the `export` line that puts it in the
 * harness's environment and the `mcpServers` block that reads it from there — the block itself
 * carries no secret (`mcp-snippet.ts`).
 */
export function TokenOnce({ token, agentName }: { token: string; agentName: string }) {
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
          Copy and save it now. If you lose it, revoke this token and create a new agent.
        </AlertDescription>
      </Alert>

      <CodeBlock label="The agent's token" code={token} copyLabel="Copy token" />
      <HarnessSetup token={token} agentName={agentName} />
    </div>
  );
}
