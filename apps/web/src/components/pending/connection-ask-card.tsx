import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectionFormFields, HostsNotice } from "@/components/connection/connection-form";
import { CredentialFields } from "@/components/connection/credential-fields";
import { ConsentStatus, OAuthClientNotice } from "@/components/connection/oauth-client-notice";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import { OpenInNewIcon } from "@/components/icons";
import { AskCard, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { Badge } from "@/components/ui/badge";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { agentKeys } from "@/lib/agent-queries";
import { ApiError } from "@/lib/api";
import {
  type ConnectionDraft,
  type ConnectionRegistration,
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
    mutationFn: (value: ConnectionRegistration & { credential: Record<string, string> }) =>
      submitConnectionProposal(action.id, value),
    onSuccess: ({ connection, authorizeUrl }) => {
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
        description: `In ${action.agent?.name ?? "the agent"}'s scope; its waiting call answers connected. Other agents get it when you add it to theirs.`,
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
    connect.mutate(verdict.value);
  };

  const open = isOpen(action);
  const hosts = hostsOf(draft) ?? payload.hosts;
  const oauth = isOAuthDraft(draft);
  // Once the client is saved and the popup is open, the form's job is done; the callback settles it.
  const consenting = consent.state.phase !== "idle" && consent.state.phase !== "done";
  const busy = connect.isPending || decline.isPending || consenting;

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">connect</span>
          <span>{payload.displayName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
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
            Connected. The connection is in the agent's scope and its waiting call answers
            connected; other agents get it when you add it to theirs.{" "}
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

      {open ? (
        <>
          <FieldSet>
            <FieldLegend variant="label">
              The connection, as proposed — edit what is wrong
            </FieldLegend>
            <FieldGroup>
              <ConnectionFormFields
                draft={draft}
                onChange={setDraft}
                errors={errors}
                idPrefix={`ask-${action.id}`}
                disabled={busy}
              />
            </FieldGroup>
          </FieldSet>
          <HostsNotice draft={draft} />
          <OAuthClientNotice draft={draft} />
          <FieldSet>
            <FieldLegend variant="label">
              {oauth
                ? "The client secret — entered here, never through the agent"
                : "The secret — entered here, never through the agent"}
            </FieldLegend>
            <FieldGroup>
              <CredentialFields
                scheme={draft.scheme}
                value={draft.credential}
                onChange={(credential) => setDraft({ ...draft, credential })}
                errors={errors}
                idPrefix={`ask-${action.id}`}
                disabled={busy}
              />
            </FieldGroup>
          </FieldSet>
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
