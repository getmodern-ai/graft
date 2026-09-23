import { isAwaitingHarness } from "@graft/core/setup/setup.rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useState } from "react";

import { HarnessSetup } from "@/components/agent/harness-setup";
import { SetupPromptBlock } from "@/components/agent/setup-prompt-block";
import { TokenOnce } from "@/components/agent/token-once";
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
import { type Agent, agentKeys, issueAgentToken } from "@/lib/agent-queries";
import { mcpEndpointUrl } from "@/lib/mcp-snippet";
import { promptHarnessOfClient } from "@/lib/setup-prompt-harness";

/**
 * Reopens setup without retrieving a token (ADR 0007, ADR 0018). Named for what the person does,
 * "Connect a harness", never "connection": that word is a vendor account (CONTEXT.md) and the
 * screen beside this one (GRA-168). Both forms end with the setup prompt for the agent (GRA-205):
 * the harness the person picks for a static token, the client that consented for an OAuth agent.
 *
 * An agent **awaiting its harness** (ADR 0024; GRA-208), which Setup minted with no token and no
 * client, has not been connected either way yet, so the dialog offers both: the URL a chat
 * product or CLI signs in at, whose consent page chooses this agent, and *Issue a token* for a
 * static-token harness (`POST /api/agents/:id/token`), which shows the token once as creation does.
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
  // Held here, not in the branch that issued it: the agents list refetched after the issue reads
  // the agent with a token, which would otherwise swap the branch and drop the one view of it.
  const [issued, setIssued] = useState<string | null>(null);

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
          {issued ? (
            <TokenOnce token={issued} agentName={agent.name} />
          ) : agent.tokenPrefix ? (
            <HarnessSetup agentName={agent.name} />
          ) : isAwaitingHarness(agent) ? (
            <AwaitingHarness agent={agent} onIssued={setIssued} />
          ) : (
            <OAuthSetup agent={agent} />
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OAuthSetup({
  agent,
  awaiting = false,
  children,
}: {
  agent: Agent;
  awaiting?: boolean;
  /** Drawn between the consent sentence and the setup prompt. */
  children?: ReactNode;
}) {
  return (
    <>
      <CodeBlock
        label="MCP server URL"
        code={mcpEndpointUrl(window.location.origin)}
        copyLabel="Copy URL"
      />
      <p className="text-muted-foreground">
        {awaiting
          ? `For a harness that signs in with OAuth (Claude, ChatGPT, Claude Code, Codex): add this URL, then sign in to Graft; ${agent.name} is already chosen on the consent page. OAuth manages the token for you.`
          : `Add this URL to your harness, then sign in to Graft and choose ${agent.name} on the connection screen. OAuth manages the token for you.`}
      </p>
      {children}
      <SetupPromptBlock
        harness={promptHarnessOfClient(agent.connectedVia?.clientName)}
        agentName={agent.name}
      />
    </>
  );
}

function AwaitingHarness({ agent, onIssued }: { agent: Agent; onIssued: (token: string) => void }) {
  const queryClient = useQueryClient();
  const issue = useMutation({
    mutationFn: () => issueAgentToken(agent.id),
    onSuccess: (issued) => {
      onIssued(issued.token);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
  });

  return (
    <OAuthSetup agent={agent} awaiting>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">
          For a harness that takes a static token (Hermes, OpenClaw, another MCP client), issue{" "}
          {agent.name}'s token here. It is shown once.
        </p>
        <div>
          <Button variant="outline" disabled={issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? "Issuing…" : "Issue a token"}
          </Button>
        </div>
      </div>
    </OAuthSetup>
  );
}
