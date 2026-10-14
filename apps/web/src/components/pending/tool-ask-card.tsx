import {
  ALLOW_VENDOR_DESTRUCTIVE_LABEL,
  allowVendorDestructiveDescription,
  allowVendorLabel,
} from "@graft/core/approval/vendor-approval.rules";
import { toolProvenance } from "@graft/core/stock/tool-provenance.rules";
import { useState } from "react";

import { AskCard, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type Ask, isOpen } from "@/lib/pending-action-queries";
import { toolAskIntegrationName, toolAskSettledSentence, toolAskToast } from "@/lib/tool-ask-copy";

/**
 * A tool's ask (ADR 0008): the wire name and annotations, the connection and hosts it would reach,
 * and the tool's description, marked with where the tool came from (`toolProvenance`, the one
 * source the ask card and the elicitation form share; GRA-245): a stock copy's was reviewed before
 * release, a remix's and an authored tool's were written by the agent's model, and a person deciding
 * on a write should know which.
 * The answer becomes the standing approval, for a destructive tool as for a write; the switch is the
 * person's opt-in to be asked before every call instead, and rides the same answer (ADR 0008,
 * amendment of 2026-09-15). It starts where the setting stands, so what the card shows is what the
 * answer records.
 *
 * Beside Approve, "Allow every <integration> tool for this agent" (ADR 0008 as amended 2026-10-09;
 * GRA-237) records this tool's yes and the agent's standing approval for the integration, with
 * destructive tools a separate tick, off by default. The words are `@graft/core`'s, shared with the
 * ask card; the settled line and the toast are `lib/tool-ask-copy.ts`'s.
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
  const [includesDestructive, setIncludesDestructive] = useState(false);
  const destructive = payload.annotations.destructiveHint;
  const integration = toolAskIntegrationName(payload);
  const answer = useAnswerAsk(action, onAnswered, "agent", (said) =>
    toolAskToast(said, integration),
  );
  const provenance = toolProvenance(payload.provenance);

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
      settled={(recorded) => toolAskSettledSentence(recorded, integration)}
      pending={answer.isPending}
      onAnswer={(allow) => answer.mutate({ allow, ...(allow ? { askEveryCall } : {}) })}
      alsoApprove={{
        label: allowVendorLabel(integration),
        onClick: () =>
          answer.mutate({ allow: true, askEveryCall, allowVendor: true, includesDestructive }),
      }}
    >
      <figure className="flex flex-col gap-1.5">
        <figcaption className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <Badge variant="outline">{provenance.badge}</Badge>
          {provenance.note}
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
                : "This tool can change data in the integration. "}
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
      {isOpen(action) ? (
        // The separate tick for "Allow every <integration> tool": off by default, read only by
        // that button, as `build-approval-item.tsx` composes its choice.
        <Item variant="outline">
          <ItemMedia>
            <Checkbox
              id={`includes-destructive-${action.id}`}
              checked={includesDestructive}
              disabled={answer.isPending}
              onCheckedChange={(next) => setIncludesDestructive(next === true)}
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="line-clamp-none">
              <Label htmlFor={`includes-destructive-${action.id}`} className="cursor-pointer">
                {ALLOW_VENDOR_DESTRUCTIVE_LABEL}
              </Label>
            </ItemTitle>
            <ItemDescription className="line-clamp-none">
              Only with {allowVendorLabel(integration)}.{" "}
              {allowVendorDestructiveDescription(integration)}
            </ItemDescription>
          </ItemContent>
        </Item>
      ) : null}
    </AskCard>
  );
}
