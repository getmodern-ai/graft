import { type RefObject, useState } from "react";

import { HarnessSetup } from "@/components/agent/harness-setup";
import { CodeBlock } from "@/components/code-block";
import { KeyIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Agent } from "@/lib/agent-queries";
import { mcpEndpointUrl } from "@/lib/mcp-snippet";

/** Reopens setup without retrieving or minting a token (ADR 0007, ADR 0018). */
export function AgentConnectionDialog({
  agent,
  onClose,
  returnFocus,
}: {
  agent: Agent;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Connection details</DialogTitle>
          <DialogDescription>
            Connect a harness to {agent.name} using the settings below.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          {agent.tokenPrefix ? (
            <>
              <Alert>
                <KeyIcon />
                <AlertTitle>Use your saved token</AlertTitle>
                <AlertDescription>
                  <p>
                    The token starting with <code className="font-mono">{agent.tokenPrefix}…</code>{" "}
                    was shown when you created this agent. It cannot be shown again.
                  </p>
                  <p>If you no longer have it, archive this agent and create a new one.</p>
                </AlertDescription>
              </Alert>
              <HarnessSetup />
            </>
          ) : (
            <>
              <CodeBlock
                label="MCP server URL"
                code={mcpEndpointUrl(window.location.origin)}
                copyLabel="Copy URL"
              />
              <p className="text-muted-foreground">
                Add this URL to your harness, then sign in to Graft and choose {agent.name} on the
                connection screen. OAuth manages the token for you.
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
