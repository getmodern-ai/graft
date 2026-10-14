import { CodeBlock } from "@/components/code-block";
import { AskCard, type AskLayout, useAnswerAsk } from "@/components/pending/ask-card";
import type { PendingAction } from "@/lib/pending-action-queries";

/**
 * An ask of a kind this console does not know — a newer server, or a payload missing what its kind
 * promises. Shown rather than hidden, because a waiting call is behind it; the kind and the raw
 * payload are what a person can act on until the console learns the kind. On the handoff page
 * (`focused`, GRA-314) the payload sits behind *Details*.
 */
export function UnknownAskCard({
  action,
  onAnswered,
  layout = "card",
}: {
  action: PendingAction;
  onAnswered?: () => void;
  layout?: AskLayout;
}) {
  const answer = useAnswerAsk(action, onAnswered);
  const sent = (
    <CodeBlock label="What the agent sent" code={JSON.stringify(action.payload, null, 2)} />
  );
  const vendor = typeof action.payload.vendor === "string" ? action.payload.vendor : action.kind;
  return (
    <AskCard
      action={action}
      title={<span>{action.kind}</span>}
      settled={(recorded) => (recorded?.allow === true ? "Approved." : "Declined.")}
      pending={answer.isPending}
      onAnswer={(allow) => answer.mutate({ allow })}
      {...(layout === "focused"
        ? {
            focused: {
              vendor,
              integrationName: vendor,
              question: `Answer ${action.agent?.name ?? "your agent"}'s ${action.kind} request?`,
              lead: "This page does not know how to show it. What the agent sent is under Details.",
              details: { label: "Details", content: sent },
            },
          }
        : {})}
    >
      {layout === "focused" ? null : (
        <>
          <p className="text-muted-foreground">
            This console does not know how to show a{" "}
            <code className="font-mono">{action.kind}</code> ask; what the agent sent is below.
          </p>
          {sent}
        </>
      )}
    </AskCard>
  );
}
