import { BuildAskCard } from "@/components/pending/build-ask-card";
import { ToolAskCard } from "@/components/pending/tool-ask-card";
import { UnknownAskCard } from "@/components/pending/unknown-ask-card";
import { type PendingAction, readAsk } from "@/lib/pending-action-queries";

/**
 * One pending action, by kind (ADR 0006). Kept to the dispatch alone: a kind's card lives in its own
 * file, so a later kind — GRA-28's connection proposal and credential re-entry — is one branch here
 * and one file beside the others.
 */
export function PendingActionCard({
  action,
  onAnswered,
}: {
  action: PendingAction;
  onAnswered?: () => void;
}) {
  const ask = readAsk(action);
  switch (ask.kind) {
    case "tool":
      return <ToolAskCard ask={ask} onAnswered={onAnswered} />;
    case "build":
      return <BuildAskCard ask={ask} onAnswered={onAnswered} />;
    default:
      return <UnknownAskCard action={action} onAnswered={onAnswered} />;
  }
}
