import { KEYRING_PROVIDER } from "@graft/core/connection/provider";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { AskCard, type AskOrigin, DocsLink, Hosts } from "@/components/pending/ask-card";
import { BuildApprovalItem } from "@/components/pending/build-approval-item";
import { Badge } from "@/components/ui/badge";
import { agentKeys } from "@/lib/agent-queries";
import { approvalKeys } from "@/lib/approval-queries";
import {
  type Ask,
  answerPendingAction,
  isOpen,
  type PendingAnswer,
  pendingKeys,
} from "@/lib/pending-action-queries";

/**
 * An agent's ask to use a connection the person already holds (GRA-104; ADR 0006, ADR 0007). The
 * agent proposed a vendor and hosts a connection of the person's already reaches, made for another
 * of their agents; nothing here is the agent's to edit and nothing is entered, so the card is the
 * connection's facts, GRA-75's build choice, Allow and Decline. Allow adds the connection to the asking
 * agent's scope (ADR 0007) and, with the choice left on, records its build approval in the same
 * transaction on the generic answer route
 * (`POST /pending-actions/:id/answer` with `{ allow: true, approveBuild }`); the agent's waiting
 * `request_connection` then answers connected with the execute tool named. Decline is
 * `{ allow: false }`, which the agent reads as a decline.
 */
export function ScopeAskCard({
  ask,
  onAnswered,
  origin = "agent",
}: {
  ask: Extract<Ask, { kind: "scope" }>;
  onAnswered?: () => void;
  /** Setup's connect step passes `setup`: the documentation link is not the agent's reading. */
  origin?: AskOrigin;
}) {
  const { action, payload } = ask;
  const queryClient = useQueryClient();
  const [approveBuild, setApproveBuild] = useState(true);
  const agentName = action.agent?.name ?? "the agent";
  const provider: string = payload.provider ?? KEYRING_PROVIDER;

  const answer = useMutation({
    mutationFn: (value: PendingAnswer) => answerPendingAction(action.id, value),
    onSuccess: (_result, submitted) => {
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      queryClient.invalidateQueries({ queryKey: approvalKeys.ofAgent(action.agentId) });
      if (submitted.allow) {
        toast.success(`${payload.displayName} is in ${agentName}'s scope`, {
          description: `${submitted.approveBuild ? "Allowed to build tools against it; its" : "Its"} waiting call answers connected. Nothing was entered and no new connection was made.`,
        });
      } else {
        toast.success("Declined", { description: "The agent's waiting call is refused." });
      }
      onAnswered?.();
    },
  });

  const open = isOpen(action);

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">use</span>
          <span>{payload.displayName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
          {provider === KEYRING_PROVIDER ? null : <Badge variant="outline">via {provider}</Badge>}
        </>
      }
      where={
        <>
          at <Hosts hosts={payload.hosts} />
        </>
      }
      settled={(recorded) =>
        recorded?.allow === true ? (
          <>
            Allowed. The connection is in the agent's scope
            {recorded.approveBuild === true ? ", and it may build tools against it" : ""}; its
            waiting call answers connected.{" "}
            <Link to="/agents" className="underline underline-offset-4">
              See agents
            </Link>
            .
          </>
        ) : (
          "Declined. Nothing changed; the agent is told so."
        )
      }
      approveLabel="Allow"
      pending={answer.isPending}
      onAnswer={(allow) => answer.mutate(allow ? { allow: true, approveBuild } : { allow: false })}
    >
      <p className="text-muted-foreground">
        You already have this connection; it was made for another of your agents. Allowing adds it
        to {agentName}'s scope: no new connection, nothing entered, and the connection's approvals
        stay as they are. Other agents get it when you add it to theirs.
      </p>
      {payload.docsUrl ? <DocsLink href={payload.docsUrl} origin={origin} /> : null}
      {open ? (
        <BuildApprovalItem
          id={`ask-${action.id}-approve-build`}
          agentName={agentName}
          checked={approveBuild}
          onCheckedChange={setApproveBuild}
          disabled={answer.isPending}
        />
      ) : null}
    </AskCard>
  );
}
