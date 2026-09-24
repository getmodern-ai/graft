import { type RefObject, useState } from "react";

import { HarnessSetup } from "@/components/agent/harness-setup";
import { SetupPromptBlock } from "@/components/agent/setup-prompt-block";
import { CodeBlock } from "@/components/code-block";
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
import { promptHarnessOfClient } from "@/lib/setup-prompt-harness";

/**
 * Reopens setup without retrieving or minting a token (ADR 0007, ADR 0018). Named for what the
 * person does, "Connect a harness", never "connection": that word is a vendor account
 * (CONTEXT.md) and the screen beside this one (GRA-168). Both forms end with the setup prompt for
 * the agent (GRA-205): the harness the person picks for a static token, the client that consented
 * for an OAuth agent.
 */
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
          <DialogTitle>Connect a harness</DialogTitle>
          <DialogDescription>
            Point the harness that will run as {agent.name} at Graft with the settings below.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          {agent.tokenPrefix ? (
            <HarnessSetup agentName={agent.name} />
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
              <SetupPromptBlock
                harness={promptHarnessOfClient(agent.connectedVia?.clientName)}
                agentName={agent.name}
              />
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
