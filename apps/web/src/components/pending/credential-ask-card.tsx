import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { CredentialFields } from "@/components/connection/credential-fields";
import { ConsentStatus } from "@/components/connection/oauth-client-notice";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import { AskCard, Hosts, useAnswerAsk } from "@/components/pending/ask-card";
import { Badge } from "@/components/ui/badge";
import { FieldGroup } from "@/components/ui/field";
import {
  credentialFieldsFor,
  type DraftErrors,
  emptyFields,
  validateCredentialDraft,
} from "@/lib/connection-form";
import { connectionKeys, submitCredentialRequest } from "@/lib/connection-queries";
import { startOAuthConsent } from "@/lib/oauth-consent";
import { type Ask, isOpen, pendingKeys } from "@/lib/pending-action-queries";

/**
 * An agent's ask to re-enter a connection's credential (GRA-28) — after a vendor 401 or 403, or
 * after a revoke, when the re-entry is the reconnection (ADR 0007). The scheme's secret inputs come
 * from the table; the new credential replaces the old through the action's own submit route and
 * touches no approval (ADR 0008). What the vendor said is shown in the agent's words, marked so.
 *
 * For an OAuth connection (ADR 0005) the answer is a consent: with the client secret still in place
 * the card asks for nothing and Reconnect opens the popup; after a revoke it asks for the client
 * secret first and the consent follows. Either way the callback answers the ask, so the agent's
 * waiting call says connected once the tokens are stored.
 */
export function CredentialAskCard({
  ask,
  onAnswered,
}: {
  ask: Extract<Ask, { kind: "credential" }>;
  onAnswered?: () => void;
}) {
  const { action, payload } = ask;
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState<Record<string, string>>(() =>
    emptyFields(credentialFieldsFor(payload.scheme)),
  );
  const [errors, setErrors] = useState<DraftErrors>({});
  const decline = useAnswerAsk(action, onAnswered);
  const oauth = payload.scheme === "oauth_authorization_code";
  // The client secret survives a refused refresh and goes with a revoke (ADR 0007).
  const needsSecret = !oauth || payload.revoked;
  const consent = useOAuthConsent({
    onConnected: () => {
      toast.success(`${payload.connectionName} is connected`, {
        description: "The consent completed; the agent's waiting call answers connected.",
      });
      onAnswered?.();
    },
  });

  const save = useMutation({
    mutationFn: (value: Record<string, string>) => submitCredentialRequest(action.id, value),
    onSuccess: ({ connection, authorizeUrl }) => {
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      if (authorizeUrl) {
        toast.message(`${connection.displayName}'s client secret is saved`, {
          description:
            "Complete the consent in the popup; the agent is told once the tokens are stored.",
        });
        void consent.run(authorizeUrl, connection);
        return;
      }
      toast.success(`${connection.displayName}'s credential is set`, {
        description: payload.revoked
          ? "Reconnected. Its tools ask again on their own terms; the agent's waiting call answers connected."
          : "The agent's waiting call answers connected; approvals are unchanged.",
      });
      onAnswered?.();
    },
  });

  const reconsent = useMutation({
    mutationFn: () => startOAuthConsent(payload.connectionId, action.id),
    onSuccess: ({ authorizeUrl, connection }) => void consent.run(authorizeUrl, connection),
  });

  const submit = () => {
    if (!needsSecret) {
      reconsent.mutate();
      return;
    }
    const verdict = validateCredentialDraft(payload.scheme, credential);
    if (!verdict.ok) {
      setErrors(verdict.errors);
      return;
    }
    setErrors({});
    save.mutate(verdict.value);
  };

  const busy = save.isPending || decline.isPending || reconsent.isPending || consent.running;

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">
            {oauth ? "reconnect" : "re-enter the credential for"}
          </span>
          <span>{payload.connectionName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
          {payload.revoked ? <Badge variant="destructive">revoked</Badge> : null}
        </>
      }
      where={
        <>
          at <Hosts hosts={payload.hosts} />
        </>
      }
      settled={(recorded) =>
        typeof recorded?.connectionId === "string"
          ? oauth
            ? "Reconnected. The agent's waiting call answers connected; approvals are unchanged."
            : "Credential re-entered. The agent's waiting call answers connected; approvals are unchanged."
          : "Declined. The credential stands as it was; the agent is told so."
      }
      approveLabel={oauth ? (needsSecret ? "Save and reconnect" : "Reconnect") : "Save credential"}
      pending={busy}
      onAnswer={(allow) => (allow ? submit() : decline.mutate({ allow: false }))}
    >
      {payload.reason ? (
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <Badge variant="outline">in the agent's words</Badge>
            What the vendor answered, as the agent reports it.
          </figcaption>
          <blockquote className="border-l-2 pl-3 italic">{payload.reason}</blockquote>
        </figure>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {oauth
          ? payload.revoked
            ? "This connection was revoked, and its client secret with it. Enter the secret of the client you registered at the vendor; the consent then runs in a popup and reconnects it."
            : "The client secret is still in place. Reconnect runs the vendor's consent again in a popup; the new tokens replace the old, and no approval is touched."
          : payload.revoked
            ? "This connection was revoked. Entering a credential reconnects it: its tools stay and ask again on their own terms."
            : `The new credential replaces the old one for scheme ${payload.scheme}; nothing else about the connection changes, and no approval is touched.`}
      </p>
      {isOpen(action) && needsSecret ? (
        <FieldGroup>
          <CredentialFields
            scheme={payload.scheme}
            value={credential}
            onChange={setCredential}
            errors={errors}
            idPrefix={`ask-${action.id}`}
            disabled={busy}
            autoFocus
          />
        </FieldGroup>
      ) : null}
      <ConsentStatus state={consent.state} />
    </AskCard>
  );
}
