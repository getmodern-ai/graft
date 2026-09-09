import { useState } from "react";

import { AskCard, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type Ask, isOpen } from "@/lib/pending-action-queries";

/**
 * A tool's ask (ADR 0008): the wire name and annotations, the connection and hosts it would reach,
 * and the tool's description — marked as the agent's model's own words, because that is what it is,
 * and a person deciding on a write should know the sentence was not written by anyone accountable.
 * The answer becomes the standing approval; for a destructive tool a switch relaxes the per-call ask
 * in the same answer.
 */
export function ToolAskCard({
  ask,
  onAnswered,
}: {
  ask: Extract<Ask, { kind: "tool" }>;
  onAnswered?: () => void;
}) {
  const { action, payload } = ask;
  const [relax, setRelax] = useState(false);
  const destructive = payload.annotations.destructiveHint;
  const answer = useAnswerAsk(action, onAnswered);

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">run</span>
          <code className="font-mono">{payload.toolName}</code>
          <ToolAnnotations
            readOnly={payload.annotations.readOnlyHint}
            destructive={payload.annotations.destructiveHint}
          />
        </>
      }
      where={
        <>
          against <span className="font-medium text-foreground">{payload.connectionName}</span> at{" "}
          <Hosts hosts={payload.hosts} />
        </>
      }
      settled={(recorded) =>
        recorded?.allow === true
          ? "Approved. The answer holds for this agent's next calls until withdrawn on its page."
          : "Declined. The no holds for this agent until withdrawn on its page."
      }
      pending={answer.isPending}
      onAnswer={(allow) => answer.mutate({ allow, ...(destructive && allow ? { relax } : {}) })}
    >
      <figure className="flex flex-col gap-1.5">
        <figcaption className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <Badge variant="outline">written by the agent's model</Badge>
          {payload.note}
        </figcaption>
        <blockquote className="border-l-2 pl-3 italic">{payload.description}</blockquote>
      </figure>
      {destructive && isOpen(action) ? (
        <div className="flex items-start gap-3 rounded-md border p-3">
          <Switch
            id={`relax-${action.id}`}
            checked={relax}
            onCheckedChange={(checked) => setRelax(checked)}
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={`relax-${action.id}`}>
              Stop asking for every call of this destructive tool
            </Label>
            <p className="text-muted-foreground text-xs">
              A destructive tool asks every time until you relax it. Relaxed, this approval holds
              like an ordinary write's and later calls pass silently for this agent; withdrawing it
              on the agent's page makes it ask again.
            </p>
          </div>
        </div>
      ) : null}
    </AskCard>
  );
}
