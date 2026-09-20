import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { OpenInNewIcon, WarningIcon } from "@/components/icons";
import { AskCard, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { BuildApprovalItem } from "@/components/pending/build-approval-item";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { agentKeys } from "@/lib/agent-queries";
import { ApiError, api } from "@/lib/api";
import { type Connection, connectionKeys } from "@/lib/connection-queries";
import { openConsentPopup } from "@/lib/oauth-consent";
import {
  type Ask,
  HANDOFF_TOKEN_PARAM_NAME,
  isOpen,
  type PendingAction,
  pendingKeys,
} from "@/lib/pending-action-queries";
import {
  awaitLink,
  type LinkOutcome,
  type LinkSettled,
  startProviderLink,
} from "@/lib/provider-link";

/**
 * An agent's proposal for a connection a **link** provider covers (ADR 0019; GRA-59): the vendor,
 * the hosts, and the provider that connects it — named by the ask, with what it calls the vendor —
 * with one button and no form. Connect asks the server to mint the provider's link for this ask
 * (`POST /api/pending-actions/:id/link`), opens it in a popup where the person signs in at the
 * vendor on the provider's page, and waits — for the console's `/link/callback` route to post the
 * outcome, or for the ask to read as answered — while the server's return route makes the
 * connection and answers the ask (`apps/server/src/provider-link.ts`). The vendor's token stays
 * with the provider; nothing is typed here, and nothing secret is stored anywhere in Graft.
 *
 * A failed or abandoned link leaves the ask open with the reason under the button, and Connect
 * tries again with a fresh link. Decline is the generic answer with no connection on it, which the
 * agent reads as a decline — as for the form's card (`connection-ask-card.tsx`).
 *
 * The card's one control is the build approval, on by default (GRA-75; ADR 0008, amendment of
 * 2026-09-18), as on the form's card. It is posted with the button — the connection does not exist
 * until the return — and the server signs it into the link's state, so the return records it with
 * the connection it makes.
 */
export function ProviderLinkAskCard({
  ask,
  onAnswered,
}: {
  ask: Extract<Ask, { kind: "connection-link" }>;
  onAnswered?: () => void;
}) {
  const { action, payload } = ask;
  const queryClient = useQueryClient();
  const decline = useAnswerAsk(action, onAnswered);
  const [state, setState] = useState<LinkState>({ phase: "idle" });
  const [approveBuild, setApproveBuild] = useState(true);
  const stop = useRef<AbortController | null>(null);
  const provider = payload.provider;
  const target = payload.providerTarget ?? null;
  const agentName = action.agent?.name ?? "the agent";

  const settleAndRefresh = useCallback(
    (outcome: LinkOutcome, message: string, connectionId: string | null) => {
      setState({ phase: "done", outcome, message });
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      if (outcome === "connected") {
        toast.success(`${payload.displayName} is connected through ${provider}`, {
          description: `In ${agentName}'s scope${approveBuild ? ", allowed to build tools against it" : ""}; its waiting call answers connected. The account's token stays with ${provider}.`,
        });
        onAnswered?.();
      }
      return connectionId;
    },
    [queryClient, payload.displayName, provider, agentName, approveBuild, onAnswered],
  );

  const start = useMutation({
    mutationFn: () => startProviderLink(action.id, { approveBuild }),
    onSuccess: async ({ url }) => {
      const popup = openConsentPopup(url);
      if (!popup) {
        setState({ phase: "blocked", url });
        return;
      }
      stop.current?.abort();
      const controller = new AbortController();
      stop.current = controller;
      setState({ phase: "running" });
      const { outcome, message, connectionId } = await awaitLink({
        popup,
        pendingActionId: action.id,
        isSettled: () => readSettled(action, payload),
        signal: controller.signal,
      });
      if (stop.current === controller) stop.current = null;
      settleAndRefresh(outcome, message, connectionId);
    },
  });

  const cancel = () => stop.current?.abort();
  const open = isOpen(action);
  const running = state.phase === "running";
  const busy = start.isPending || decline.isPending || running;

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">connect</span>
          <span>{payload.displayName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
          <Badge variant="outline">via {provider}</Badge>
          {target ? <Badge variant="outline">{`${provider} app ${target}`}</Badge> : null}
        </>
      }
      where={
        <>
          at <Hosts hosts={payload.hosts} />
        </>
      }
      settled={(recorded) =>
        typeof recorded?.connectionId === "string" ? (
          <>
            Connected through {provider}. The connection is in the agent's scope and its waiting
            call answers connected; the account's token stays with {provider}.{" "}
            <Link to="/connections" className="underline underline-offset-4">
              See connections
            </Link>
            .
          </>
        ) : (
          "Declined. Nothing was connected; the agent is told so."
        )
      }
      approveLabel={running ? "Waiting for the sign-in…" : `Connect through ${provider}`}
      pending={busy}
      onAnswer={(allow) => (allow ? start.mutate() : decline.mutate({ allow: false }))}
    >
      <figure className="flex flex-col gap-1.5">
        <figcaption className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <Badge variant="outline">proposed by the agent's model</Badge>
          {payload.note}
        </figcaption>
        {payload.docsUrl ? (
          <a
            href={payload.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
          >
            The documentation the agent read: {payload.docsUrl}
            <OpenInNewIcon className="size-3" />
          </a>
        ) : (
          <p className="text-muted-foreground text-xs">
            The agent named no documentation page. Check the hosts against the vendor's own.
          </p>
        )}
      </figure>

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Primary host</dt>
        <dd>
          <code className="font-mono text-xs">{payload.primaryHost}</code>
        </dd>
        <dt className="text-muted-foreground">Connected through</dt>
        <dd>
          <code className="font-mono text-xs">{provider}</code>
          {target ? (
            <>
              {" "}
              <span className="text-muted-foreground">as its app</span>{" "}
              <code className="font-mono text-xs">{target}</code>
            </>
          ) : null}
        </dd>
      </dl>

      {open ? (
        <>
          <p className="text-muted-foreground text-xs">
            One click. Connect opens {provider}'s sign-in for {payload.vendor} in a popup, and you
            sign in at the vendor there. The account's token stays with {provider}; Graft stores
            only the account's id and relays every call for this connection through {provider}.
            Nothing is typed here, and nothing secret is stored in Graft.
          </p>
          <BuildApprovalItem
            id={`ask-${action.id}-approve-build`}
            agentName={agentName}
            checked={approveBuild}
            onCheckedChange={setApproveBuild}
            disabled={busy}
          />
        </>
      ) : null}

      <LinkStatus state={state} provider={provider} onCancel={cancel} />
    </AskCard>
  );
}

/** Where the link stands: the popup is open, the browser refused it, or how it ended. */
type LinkState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "blocked"; url: string }
  | { phase: "done"; outcome: LinkOutcome; message: string };

function LinkStatus({
  state,
  provider,
  onCancel,
}: {
  state: LinkState;
  provider: string;
  onCancel: () => void;
}) {
  switch (state.phase) {
    case "idle":
      return null;
    case "running":
      return (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          <span>
            Sign in at the vendor in {provider}'s popup. This card updates once you have been sent
            back.
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Stop waiting
          </Button>
        </div>
      );
    case "blocked":
      return (
        <Alert>
          <WarningIcon />
          <AlertTitle>The browser blocked the popup</AlertTitle>
          <AlertDescription>
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 underline underline-offset-4"
            >
              Open {provider}'s sign-in page
              <OpenInNewIcon className="size-3" />
            </a>{" "}
            and come back here once it says connected.
          </AlertDescription>
        </Alert>
      );
    case "done":
      return state.outcome === "connected" ? null : (
        <Alert variant={state.outcome === "failed" ? "destructive" : "default"}>
          <WarningIcon />
          <AlertTitle>
            {state.outcome === "declined"
              ? "The sign-in was declined"
              : state.outcome === "stopped"
                ? "Stopped waiting for the sign-in"
                : state.outcome === "expired"
                  ? "The link took too long"
                  : "The sign-in did not complete"}
          </AlertTitle>
          <AlertDescription>
            {state.message ||
              `Nothing was connected; the ask is still open. Press Connect through ${provider} to try again.`}
          </AlertDescription>
        </Alert>
      );
  }
}

/**
 * The card's read of its own ask while the link runs: answered with a connection is connected,
 * answered without one is a decline; the link the card was opened from carries the token the read
 * needs (`action.url`). Once the agent has taken the answer the server answers `409 consumed` and
 * the answer is out of reach, so the read turns to the connections list: a live connection of this
 * provider at this vendor and primary host is what the ask was for, and its absence is the decline.
 */
async function readSettled(
  action: PendingAction,
  payload: { provider: string; vendor: string; primaryHost: string },
): Promise<LinkSettled> {
  const token = new URL(action.url).searchParams.get(HANDOFF_TOKEN_PARAM_NAME) ?? "";
  try {
    const { pendingAction } = await api<{ pendingAction: PendingAction }>(
      `/pending-actions/${encodeURIComponent(action.id)}?${HANDOFF_TOKEN_PARAM_NAME}=${encodeURIComponent(token)}`,
    );
    if (pendingAction.answeredAt === null) return { settled: false };
    const connectionId = pendingAction.answer?.connectionId;
    return { settled: true, connectionId: typeof connectionId === "string" ? connectionId : null };
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
    const { connections } = await api<{ connections: Connection[] }>("/connections");
    const made = connections.find(
      (connection) =>
        connection.provider === payload.provider &&
        connection.vendor === payload.vendor &&
        connection.primaryHost === payload.primaryHost &&
        connection.revokedAt === null,
    );
    return { settled: true, connectionId: made?.id ?? null };
  }
}
