import { KEYRING_PROVIDER } from "@graft/core/connection/provider";
import type { ConnectionSubmitBody } from "@graft/server/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectionForm } from "@/components/connection/connection-form";
import { ConsentStatus } from "@/components/connection/oauth-client-notice";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import { OpenInNewIcon } from "@/components/icons";
import { AskCard, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { BuildApprovalItem } from "@/components/pending/build-approval-item";
import { Badge } from "@/components/ui/badge";
import { agentKeys } from "@/lib/agent-queries";
import { ApiError } from "@/lib/api";
import {
  type ConnectionDraft,
  type DraftErrors,
  draftFromProposal,
  hostsOf,
  isOAuthDraft,
  validateConnectionDraft,
} from "@/lib/connection-form";
import { connectionKeys, submitConnectionProposal } from "@/lib/connection-queries";
import { type Ask, isOpen, pendingKeys } from "@/lib/pending-action-queries";

/**
 * An agent's proposal for a connection (GRA-28; ADR 0006): the form opens pre-filled with everything
 * the agent said and nothing secret, editable, names every host the credential will be sent to, and
 * renders the scheme's secret inputs from the table. Connect posts the edited proposal and the
 * secret to the action's own submit route — never to the generic answer — which creates the
 * connection with its credential, gives it to the requesting agent alone (ADR 0007), and records
 * `{ connectionId }` on the action so the agent's waiting call answers connected. Decline is the
 * generic answer with no connection on it, which the agent reads as a decline.
 *
 * For an OAuth consent (GRA-30; ADR 0005) the form adds the redirect URI to register and a client id
 * input, the secret is the client secret, and Connect goes one step further: the submit stores the
 * client and answers an authorize URL, the popup runs the vendor's consent, and the callback — not
 * the submit — answers the ask once the tokens are stored, so the card settles when the agent can
 * actually call the vendor.
 *
 * The ask names the provider the proposal was routed to (ADR 0019). Every ask a keyring-only
 * deployment makes is the keyring's and draws exactly this form; an ask an older deployment recorded
 * carries no provider and reads as the keyring's. A provider that connects with a link gets its own
 * card beside this one (GRA-59); this card shows the name so a person can see which flow they are in.
 *
 * The form's last control is the build approval, on by default (GRA-75; ADR 0008, amendment of
 * 2026-09-18): Connect posts it with the proposal, and the submit records `acquire`'s approval for
 * the asking agent in the transaction that makes the connection, so the agent's first `acquire`
 * needs no second link. Unticked, the agent asks as it always did.
 */
export function ConnectionAskCard({
  ask,
  onAnswered,
}: {
  ask: Extract<Ask, { kind: "connection" }>;
  onAnswered?: () => void;
}) {
  const { action, payload } = ask;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftFromProposal(payload));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [approveBuild, setApproveBuild] = useState(true);
  const agentName = action.agent?.name ?? "the agent";
  const decline = useAnswerAsk(action, onAnswered);
  const consent = useOAuthConsent({
    onConnected: () => {
      toast.success(`${draft.displayName} is connected`, {
        description: `In ${action.agent?.name ?? "the agent"}'s scope; its waiting call answers connected. Other agents get it when you add it to theirs.`,
      });
      onAnswered?.();
    },
  });

  const connect = useMutation({
    mutationFn: (value: ConnectionSubmitBody) => submitConnectionProposal(action.id, value),
    onSuccess: ({ connection, authorizeUrl }, submitted) => {
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      if (authorizeUrl) {
        toast.message(`${connection.displayName}'s client is saved`, {
          description:
            "Complete the consent in the popup; the agent is told once the tokens are stored.",
        });
        void consent.run(authorizeUrl, connection);
        return;
      }
      toast.success(`${connection.displayName} is connected`, {
        description: `In ${agentName}'s scope${submitted.approveBuild ? ", allowed to build tools against it" : ""}; its waiting call answers connected. Other agents get it when you add it to theirs.`,
      });
      onAnswered?.();
    },
    onError: (error) => {
      // The service's refusal lands under the input it is about — the host rule above all (ADR 0010).
      if (error instanceof ApiError && error.status === 400) {
        const details = error.details as { reason?: string; host?: string } | undefined;
        if (details?.reason === "host_not_public") {
          const host = details.host ?? "";
          const primary = safeHostname(draft.primaryHost);
          setErrors({ [primary === host ? "primaryHost" : "hosts"]: error.message });
        }
      }
    },
  });

  const submit = () => {
    const verdict = validateConnectionDraft(draft);
    if (!verdict.ok) {
      setErrors(verdict.errors);
      return;
    }
    setErrors({});
    connect.mutate({ ...verdict.value, approveBuild });
  };

  const open = isOpen(action);
  const hosts = hostsOf(draft) ?? payload.hosts;
  const oauth = isOAuthDraft(draft);
  const provider: string = payload.provider ?? KEYRING_PROVIDER;
  const widens = payload.widens ?? null;
  // Once the client is saved and the popup is open, the form's job is done; the callback settles it.
  const consenting = consent.state.phase !== "idle" && consent.state.phase !== "done";
  const busy = connect.isPending || decline.isPending || consenting;

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">{widens ? "widen" : "connect"}</span>
          <span>{payload.displayName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
          {provider === KEYRING_PROVIDER ? null : <Badge variant="outline">via {provider}</Badge>}
          {oauth ? <Badge variant="outline">OAuth consent</Badge> : null}
        </>
      }
      where={
        <>
          at <Hosts hosts={hosts} />
        </>
      }
      settled={(recorded) =>
        typeof recorded?.connectionId === "string" ? (
          <>
            {widens
              ? "Confirmed. The connection now reaches the added hosts and the agent's waiting call answers connected; nothing new was made."
              : "Connected. The connection is in the agent's scope and its waiting call answers connected; other agents get it when you add it to theirs."}{" "}
            <Link to="/connections" className="underline underline-offset-4">
              See connections
            </Link>
            .
          </>
        ) : (
          "Declined. Nothing was created; the agent is told so."
        )
      }
      approveLabel="Connect"
      pending={busy}
      onAnswer={(allow) => (allow ? submit() : decline.mutate({ allow: false }))}
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

      {open && widens ? (
        // A widening (GRA-167): the row is the person's already, so nothing here is editable —
        // the added hosts, the set the row will reach, and the build choice; Connect grows the row.
        <>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Adds</dt>
            <dd>
              <Hosts hosts={widens.addedHosts} />
            </dd>
            <dt className="text-muted-foreground">Will reach</dt>
            <dd>
              <Hosts hosts={payload.hosts} />
            </dd>
            <dt className="text-muted-foreground">Primary host</dt>
            <dd>
              <code className="font-mono text-xs">{payload.primaryHost}</code>
            </dd>
            <dt className="text-muted-foreground">Scheme</dt>
            <dd>No credential (public API)</dd>
          </dl>
          <BuildApprovalItem
            id={`ask-${action.id}-approve-build`}
            agentName={agentName}
            checked={approveBuild}
            onCheckedChange={setApproveBuild}
            disabled={busy}
          />
        </>
      ) : open ? (
        <>
          <ConnectionForm
            draft={draft}
            onChange={setDraft}
            errors={errors}
            idPrefix={`ask-${action.id}`}
            disabled={busy}
          />
          <BuildApprovalItem
            id={`ask-${action.id}-approve-build`}
            agentName={agentName}
            checked={approveBuild}
            onCheckedChange={setApproveBuild}
            disabled={busy}
          />
          <ConsentStatus state={consent.state} onCancel={consent.cancel} />
        </>
      ) : (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Primary host</dt>
          <dd>
            <code className="font-mono text-xs">{payload.primaryHost}</code>
          </dd>
          <dt className="text-muted-foreground">Scheme</dt>
          <dd>
            <code className="font-mono text-xs">{payload.scheme}</code>
          </dd>
        </dl>
      )}
    </AskCard>
  );
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return null;
  }
}
