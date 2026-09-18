import { useMutation, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { toast } from "sonner";

import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { agentKeys } from "@/lib/agent-queries";
import { approvalKeys } from "@/lib/approval-queries";
import {
  answerPendingAction,
  isOpen,
  type PendingAction,
  type PendingAnswer,
  pendingKeys,
} from "@/lib/pending-action-queries";

/**
 * What every ask's card shares (ADR 0006): who asked and when, how long it stays answerable, the
 * approve and decline that answer it, and the sentence once it is settled. The kind-specific cards
 * (`tool-ask-card.tsx`, `build-ask-card.tsx`, `connection-ask-card.tsx`, `credential-ask-card.tsx`)
 * fill the title, the description line and the body, say what the answer carries beyond `allow`,
 * and name the approve button when "Approve" is not the verb — GRA-28's cards say Connect.
 */
export function useAnswerAsk(action: PendingAction, onAnswered?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (answer: PendingAnswer) => answerPendingAction(action.id, answer),
    onSuccess: (_result, answer) => {
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      queryClient.invalidateQueries({ queryKey: approvalKeys.ofAgent(action.agentId) });
      toast.success(answer.allow ? "Approved" : "Declined", {
        description: !answer.allow
          ? "The agent's waiting call is refused."
          : answer.askEveryCall
            ? "The agent's waiting call resumes, and the tool asks again next time."
            : "The agent's waiting call resumes, and the answer holds for its next calls.",
      });
      onAnswered?.();
    },
  });
}

export function AskCard({
  action,
  title,
  where,
  children,
  settled,
  onAnswer,
  pending,
  approveLabel = "Approve",
}: {
  action: PendingAction;
  /** "<agent> asks to …" — the kind's own words after the agent's name. */
  title: React.ReactNode;
  /** The vendor and hosts the ask is against, for the description line (ADR 0006). */
  where?: React.ReactNode;
  children?: React.ReactNode;
  /** What to say once answered, given the recorded answer. */
  settled: (answer: PendingAction["answer"]) => React.ReactNode;
  onAnswer: (allow: boolean) => void;
  pending: boolean;
  /** The approve button's verb; "Approve" unless the kind's act is something else. */
  approveLabel?: string;
}) {
  const open = isOpen(action);
  const agentName = action.agent?.name ?? "A revoked agent";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{agentName} asks to</span>
          {title}
        </CardTitle>
        <CardDescription>
          Asked <Time iso={action.createdAt} />
          {" · "}
          {open ? (
            <>
              expires <Time iso={action.expiresAt} />
            </>
          ) : action.answeredAt ? (
            <>
              answered <Time iso={action.answeredAt} />
            </>
          ) : (
            <>
              expired <Time iso={action.expiresAt} />
            </>
          )}
          {where ? <> · {where}</> : null}
        </CardDescription>
      </CardHeader>
      {children ? (
        <CardContent className="flex flex-col gap-4 text-sm">{children}</CardContent>
      ) : null}
      {open ? (
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={() => onAnswer(false)}>
            Decline
          </Button>
          <Button disabled={pending} onClick={() => onAnswer(true)}>
            {approveLabel}
          </Button>
        </CardFooter>
      ) : (
        <CardFooter className="text-muted-foreground text-sm">
          {action.answeredAt
            ? settled(action.answer)
            : "This ask expired without an answer; the agent will ask again if it still needs to."}
        </CardFooter>
      )}
    </Card>
  );
}

/** The hosts an ask is against, as the description line shows them. */
export function Hosts({ hosts }: { hosts: readonly string[] }) {
  return (
    <>
      {hosts.map((host) => (
        <code key={host} className="mr-1 font-mono text-xs">
          {host}
        </code>
      ))}
    </>
  );
}
