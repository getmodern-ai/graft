import {
  ALLOW_VENDOR_DESTRUCTIVE_LABEL,
  allowVendorDestructiveDescription,
  allowVendorLabel,
} from "@graft/core/approval/vendor-approval.rules";
import { toolProvenance } from "@graft/core/stock/tool-provenance.rules";
import { useState } from "react";

import { AskCard, type AskLayout, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { ChoiceCards } from "@/components/pending/choice-cards";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
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
import {
  defaultToolAllowChoice,
  type ToolAllowChoice,
  toolAllowAnswer,
  toolAllowOptions,
  toolLabel,
} from "@/lib/tool-allow-choice";
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
 *
 * On the handoff page (`layout: "focused"`, GRA-314) the two buttons and the destructive tick give
 * way to one radio over how much the yes allows (`lib/tool-allow-choice.ts`: every integration
 * tool, pre-selected on a tool that cannot delete; the tool alone; or every tool including
 * destructive ones), with the ask-every-call tick under it and the description behind *Details*.
 */
export function ToolAskCard({
  ask,
  onAnswered,
  layout = "card",
}: {
  ask: Extract<Ask, { kind: "tool" }>;
  onAnswered?: () => void;
  layout?: AskLayout;
}) {
  const { action, payload } = ask;
  const [askEveryCall, setAskEveryCall] = useState(payload.askEveryCall === true);
  const [includesDestructive, setIncludesDestructive] = useState(false);
  const destructive = payload.annotations.destructiveHint;
  const [choice, setChoice] = useState<ToolAllowChoice>(defaultToolAllowChoice(destructive));
  const integration = toolAskIntegrationName(payload);
  const answer = useAnswerAsk(action, onAnswered, "agent", (said) =>
    toolAskToast(said, integration),
  );
  const provenance = toolProvenance(payload.provenance);

  if (layout === "focused") {
    const agentName = action.agent?.name ?? "Your agent";
    const tool = toolLabel(payload.toolName, payload.vendor);
    return (
      <AskCard
        action={action}
        title={null}
        settled={(recorded) => toolAskSettledSentence(recorded, integration)}
        pending={answer.isPending}
        approveLabel="Allow"
        onAnswer={(allow) =>
          answer.mutate(allow ? toolAllowAnswer(choice, askEveryCall) : { allow: false })
        }
        focused={{
          vendor: payload.vendor,
          integrationName: integration,
          question: `Allow ${agentName} to run ${tool} in ${integration}?`,
          lead: `Through your ${payload.connectionName} connection, at ${payload.hosts.join(", ")}.`,
          summary: `${provenance.badge} · sends data to ${payload.hosts.join(", ")}`,
          declineLabel: "Deny",
          details: {
            label: "Details",
            content: (
              <figure className="flex flex-col gap-1.5">
                <figcaption className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <code className="font-mono">{payload.toolName}</code>
                  <ToolAnnotations
                    readOnly={payload.annotations.readOnlyHint}
                    destructive={payload.annotations.destructiveHint}
                  />
                </figcaption>
                <blockquote className="border-l-2 pl-3 italic">{payload.description}</blockquote>
                <p className="text-muted-foreground text-xs">{provenance.note}</p>
              </figure>
            ),
          },
        }}
      >
        <ChoiceCards
          id={`ask-${action.id}-allow`}
          legend={`How much should ${agentName} get?`}
          options={toolAllowOptions({ agentName, integrationName: integration, tool, destructive })}
          value={choice}
          onValueChange={setChoice}
          disabled={answer.isPending}
        />
        <Field orientation="horizontal" className="gap-2">
          <Checkbox
            id={`ask-every-call-${action.id}`}
            checked={askEveryCall}
            disabled={answer.isPending}
            onCheckedChange={(next) => setAskEveryCall(next === true)}
          />
          <FieldLabel htmlFor={`ask-every-call-${action.id}`} className="font-normal text-xs">
            Ask me every time {tool} runs
          </FieldLabel>
        </Field>
      </AskCard>
    );
  }

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
