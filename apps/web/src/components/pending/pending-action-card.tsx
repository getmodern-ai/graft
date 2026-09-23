import type { AskOrigin } from "@/components/pending/ask-card";
import { BuildAskCard } from "@/components/pending/build-ask-card";
import { ConnectionAskCard } from "@/components/pending/connection-ask-card";
import { CredentialAskCard } from "@/components/pending/credential-ask-card";
import { ProviderLinkAskCard } from "@/components/pending/provider-link-ask-card";
import { ScopeAskCard } from "@/components/pending/scope-ask-card";
import { ToolAskCard } from "@/components/pending/tool-ask-card";
import { UnknownAskCard } from "@/components/pending/unknown-ask-card";
import { type PendingAction, readAsk } from "@/lib/pending-action-queries";

/**
 * One pending action, by kind (ADR 0006). Kept to the dispatch alone: a kind's card lives in its own
 * file, so a later kind is one branch here and one file beside the others — as GRA-28's connection
 * proposal and credential re-entry are.
 *
 * `origin` reaches the three kinds Setup's connect step can open (a connection, a provider link, a
 * scope ask; GRA-206) and no other: every other caller leaves it unset and gets today's cards.
 */
export function PendingActionCard({
  action,
  onAnswered,
  origin,
}: {
  action: PendingAction;
  onAnswered?: () => void;
  origin?: AskOrigin;
}) {
  const ask = readAsk(action);
  switch (ask.kind) {
    case "tool":
      return <ToolAskCard ask={ask} onAnswered={onAnswered} />;
    case "build":
      return <BuildAskCard ask={ask} onAnswered={onAnswered} />;
    case "connection":
      return <ConnectionAskCard ask={ask} onAnswered={onAnswered} origin={origin} />;
    case "connection-link":
      return <ProviderLinkAskCard ask={ask} onAnswered={onAnswered} origin={origin} />;
    case "credential":
      return <CredentialAskCard ask={ask} onAnswered={onAnswered} />;
    case "scope":
      return <ScopeAskCard ask={ask} onAnswered={onAnswered} origin={origin} />;
    default:
      return <UnknownAskCard action={action} onAnswered={onAnswered} />;
  }
}
