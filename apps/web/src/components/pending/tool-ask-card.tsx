import { useState } from "react";

import { AskCard, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type Ask, isOpen } from "@/lib/pending-action-queries";

/**
 * A tool's ask (ADR 0008): the wire name and annotations, the connection and hosts it would reach,
 * and the tool's description — marked as the agent's model's own words, because that is what it is,
 * and a person deciding on a write should know the sentence was not written by anyone accountable.
 * The answer becomes the standing approval, for a destructive tool as for a write; the switch is the
 * person's opt-in to be asked before every call instead, and rides the same answer (ADR 0008,
 * amendment of 2026-09-15). It starts where the setting stands, so what the card shows is what the
 * answer records.
 */
export function ToolAskCard({
  ask,
  onAnswered,
}: {
  ask: Extract<Ask, { kind: "tool" }>;
  onAnswered?: () => void;
}) {
  const { action, payload } = ask;
  const [askEveryCall, setAskEveryCall] = useState(payload.askEveryCall === true);
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
        recorded?.allow !== true
          ? "Declined. The no holds for this agent until withdrawn on its page."
          : recorded.askEveryCall === true
            ? "Approved for this call. The tool asks again next time; turn that off on the agent's page."
            : "Approved. The answer holds for this agent's next calls until withdrawn on its page."
      }
      pending={answer.isPending}
      onAnswer={(allow) => answer.mutate({ allow, ...(allow ? { askEveryCall } : {}) })}
    >
      <figure className="flex flex-col gap-1.5">
        <figcaption className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <Badge variant="outline">written by the agent's model</Badge>
          {payload.note}
        </figcaption>
        <blockquote className="border-l-2 pl-3 italic">{payload.description}</blockquote>
      </figure>
      {isOpen(action) ? (
        // An `Item` in its outline frame — title, description and the control in its actions
        // slot — rather than a bordered box of this card's own. The clamps the primitive puts on
        // a list item's lines are lifted: this is a sentence and its consequence, not a row.
        <Item variant="outline">
          <ItemContent>
            <ItemTitle className="line-clamp-none">
              <Label htmlFor={`ask-every-call-${action.id}`}>Ask every time for this tool</Label>
            </ItemTitle>
            <ItemDescription className="line-clamp-none">
              {destructive
                ? "This tool is destructive: it can delete or overwrite data. "
                : "This tool can change data at the vendor. "}
              Off, your answer holds for this agent and later calls pass silently until withdrawn on
              its page. On, every call asks you first; you can turn it off there too.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              id={`ask-every-call-${action.id}`}
              checked={askEveryCall}
              onCheckedChange={(checked) => setAskEveryCall(checked)}
            />
          </ItemActions>
        </Item>
      ) : null}
    </AskCard>
  );
}
