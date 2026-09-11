import { CodeBlock } from "@/components/code-block";
import { AskCard, useAnswerAsk } from "@/components/pending/ask-card";
import type { PendingAction } from "@/lib/pending-action-queries";

/**
 * An ask of a kind this console does not know — a newer server, or a payload missing what its kind
 * promises. Shown rather than hidden, because a waiting call is behind it; the kind and the raw
 * payload are what a person can act on until the console learns the kind.
 */
export function UnknownAskCard({
  action,
  onAnswered,
}: {
  action: PendingAction;
  onAnswered?: () => void;
}) {
  const answer = useAnswerAsk(action, onAnswered);
  return (
    <AskCard
      action={action}
      title={<span>{action.kind}</span>}
      settled={(recorded) => (recorded?.allow === true ? "Approved." : "Declined.")}
      pending={answer.isPending}
      onAnswer={(allow) => answer.mutate({ allow })}
    >
      <p className="text-muted-foreground">
        This console does not know how to show a <code className="font-mono">{action.kind}</code>{" "}
        ask; what the agent sent is below.
      </p>
      <CodeBlock label="What the agent sent" code={JSON.stringify(action.payload, null, 2)} />
    </AskCard>
  );
}
