import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";
import { KEYRING_PROVIDER } from "@graft/core/connection/provider";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import {
  AskCard,
  type AskLayout,
  type AskOrigin,
  DocsLink,
  Hosts,
} from "@/components/pending/ask-card";
import { BuildApprovalItem } from "@/components/pending/build-approval-item";
import { ChoiceCards } from "@/components/pending/choice-cards";
import { Badge } from "@/components/ui/badge";
import {
  type AccessChoice,
  accessChoiceSent,
  accessLegend,
  accessOptions,
  DEFAULT_ACCESS_CHOICE,
} from "@/lib/access-choice";
import { agentKeys } from "@/lib/agent-queries";
import { approvalKeys } from "@/lib/approval-queries";
import {
  declinedToastDescription,
  scopeAllowedSettledSentence,
  scopeAllowedToastDescription,
} from "@/lib/ask-answered-copy";
import {
  type Ask,
  answerPendingAction,
  isOpen,
  type PendingAnswer,
  settleAnsweredAsk,
} from "@/lib/pending-action-queries";
import { providerLabel as providerName } from "@/lib/provider-name";

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
  layout = "card",
}: {
  ask: Extract<Ask, { kind: "scope" }>;
  onAnswered?: () => void;
  /** Setup's connect step passes `setup`: the documentation link is not the agent's reading. */
  origin?: AskOrigin;
  /**
   * The handoff page's `focused` (GRA-314): *Full access / Ask me first* in place of the build
   * line, Full access adding the integration's non-destructive tools to the build approval.
   */
  layout?: AskLayout;
}) {
  const { action, payload } = ask;
  const queryClient = useQueryClient();
  const [approveBuild, setApproveBuild] = useState(true);
  const [access, setAccess] = useState<AccessChoice>(DEFAULT_ACCESS_CHOICE);
  const agentName = action.agent?.name ?? "the agent";
  const provider: string = payload.provider ?? KEYRING_PROVIDER;

  const answer = useMutation({
    mutationFn: (value: PendingAnswer) => answerPendingAction(action.id, value),
    onSuccess: (result, submitted) => {
      settleAnsweredAsk(queryClient, action.id, result);
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      queryClient.invalidateQueries({ queryKey: approvalKeys.ofAgent(action.agentId) });
      queryClient.invalidateQueries({ queryKey: approvalKeys.buildsOfAgent(action.agentId) });
      // Full access records the integration's allow too (GRA-314).
      queryClient.invalidateQueries({ queryKey: approvalKeys.vendorsOfAgent(action.agentId) });
      if (submitted.allow) {
        toast.success(`${payload.displayName} is in ${agentName}'s scope`, {
          description: scopeAllowedToastDescription({
            origin,
            approveBuild: submitted.approveBuild,
          }),
        });
      } else {
        toast.success("Declined", { description: declinedToastDescription(origin) });
      }
      onAnswered?.();
    },
  });

  const open = isOpen(action);

  if (layout === "focused") {
    const integration = integrationNameFor(payload.vendor, payload.displayName);
    return (
      <AskCard
        action={action}
        title={null}
        settled={(recorded) =>
          recorded?.allow === true
            ? scopeAllowedSettledSentence({ origin, approveBuild: recorded.approveBuild === true })
            : "Declined. Nothing changed; the agent is told so."
        }
        approveLabel="Allow"
        pending={answer.isPending}
        onAnswer={(allow) =>
          answer.mutate(
            allow
              ? {
                  allow: true,
                  ...accessChoiceSent(access, { approveBuild: true, allowVendor: true }),
                }
              : { allow: false },
          )
        }
        focused={{
          vendor: payload.vendor,
          integrationName: integration,
          question: `Let ${agentName} use your ${payload.displayName} connection?`,
          lead: "You connected it for another of your agents. Nothing new is made and nothing is entered.",
          summary: `${payload.hosts.join(", ")}${provider === KEYRING_PROVIDER ? "" : ` · through ${providerName(provider)}`}`,
          ...(payload.docsUrl
            ? {
                details: {
                  label: "Details",
                  content: <DocsLink href={payload.docsUrl} origin={origin} />,
                },
              }
            : {}),
        }}
      >
        <ChoiceCards
          id={`ask-${action.id}-access`}
          legend={accessLegend(agentName)}
          options={accessOptions(agentName, integration)}
          value={access}
          onValueChange={setAccess}
          disabled={answer.isPending}
        />
      </AskCard>
    );
  }

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">use</span>
          <span>{payload.displayName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
          {provider === KEYRING_PROVIDER ? null : (
            <Badge variant="outline">via {providerName(provider)}</Badge>
          )}
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
            {scopeAllowedSettledSentence({
              origin,
              approveBuild: recorded.approveBuild === true,
            })}{" "}
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
