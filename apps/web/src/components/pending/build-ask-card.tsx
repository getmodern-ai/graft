import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";

import { AskCard, type AskLayout, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { Badge } from "@/components/ui/badge";
import type { Ask } from "@/lib/pending-action-queries";

/**
 * `acquire`'s ask (ADR 0008): once per agent per connection, because that is the moment Graft's model
 * starts reading the person's data through dry-run reads. Approving grants the build approval;
 * declining records nothing, so the next acquire asks again. On the handoff page (`focused`,
 * GRA-314) the same answer under the page's question.
 */
export function BuildAskCard({
  ask,
  onAnswered,
  layout = "card",
}: {
  ask: Extract<Ask, { kind: "build" }>;
  onAnswered?: () => void;
  layout?: AskLayout;
}) {
  const { action, payload } = ask;
  const answer = useAnswerAsk(action, onAnswered);
  const integration = integrationNameFor(payload.vendor, payload.connectionName);
  const agentName = action.agent?.name ?? "Your agent";

  return (
    <AskCard
      action={action}
      {...(layout === "focused"
        ? {
            approveLabel: "Allow",
            focused: {
              vendor: payload.vendor,
              integrationName: integration,
              question: `Allow ${agentName} to build its own ${integration} tools?`,
              lead: `Graft's model reads from ${payload.connectionName} while it writes a tool: reads only, with every write previewed and never sent.`,
              summary: payload.hosts.join(", "),
            },
          }
        : {})}
      title={
        <>
          <span className="text-muted-foreground">acquire a tool against</span>
          <span>{payload.connectionName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
        </>
      }
      where={
        <>
          at <Hosts hosts={payload.hosts} />
        </>
      }
      settled={(recorded) =>
        recorded?.allow === true
          ? "Approved. This agent may acquire against the connection without asking again."
          : "Declined. Nothing was recorded; the next acquire asks again."
      }
      pending={answer.isPending}
      onAnswer={(allow) => answer.mutate({ allow })}
    >
      {layout === "focused" ? null : (
        <p className="text-muted-foreground">
          Approving lets Graft's model read from this connection through dry runs while it authors a
          tool, and publish what it builds into your toolbox. Writes the tool later makes still ask
          on their own terms.
        </p>
      )}
    </AskCard>
  );
}
