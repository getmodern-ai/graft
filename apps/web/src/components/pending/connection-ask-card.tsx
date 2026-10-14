import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";
import { KEYRING_PROVIDER } from "@graft/core/connection/provider";
import type { ConnectionSubmitBody } from "@graft/server/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectionFormFields, HostsNotice } from "@/components/connection/connection-form";
import { CredentialFields } from "@/components/connection/credential-fields";
import { ConsentStatus, OAuthClientNotice } from "@/components/connection/oauth-client-notice";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import { KeyboardArrowDownIcon, KeyboardArrowUpIcon } from "@/components/icons";
import {
  AskCard,
  type AskLayout,
  type AskOrigin,
  Hosts,
  ProposalSource,
  useAnswerAsk,
} from "@/components/pending/ask-card";
import { BuildApprovalItem } from "@/components/pending/build-approval-item";
import { ChoiceCards } from "@/components/pending/choice-cards";
import { SecretHint } from "@/components/pending/focused-ask-card";
import { VendorToolsItem } from "@/components/pending/vendor-tools-item";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  type AccessChoice,
  accessChoiceSent,
  accessLegend,
  accessOptions,
  DEFAULT_ACCESS_CHOICE,
} from "@/lib/access-choice";
import { agentKeys } from "@/lib/agent-queries";
import { ApiError } from "@/lib/api";
import { approvalKeys } from "@/lib/approval-queries";
import { connectedSettledSentence, connectedToastDescription } from "@/lib/ask-answered-copy";
import { connectionChoicesSent, connectionChoicesShown } from "@/lib/connection-choices";
import {
  type ConnectionDraft,
  type DraftErrors,
  draftFromProposal,
  hostsOf,
  isOAuthDraft,
  secretLegend,
  validateConnectionDraft,
} from "@/lib/connection-form";
import { connectionKeys, submitConnectionProposal } from "@/lib/connection-queries";
import { proposalLead, proposalSummary } from "@/lib/handoff-copy";
import { type Ask, isOpen, pendingKeys } from "@/lib/pending-action-queries";
import { providerLabel as providerName } from "@/lib/provider-name";

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
 * needs no second link. Unticked, the agent asks as it always did. Under it, also on by default,
 * the line for the integration's tools (GRA-239; ADR 0008, amendment of 2026-10-09): the submit
 * records the agent's standing approval for the vendor, destructive tools left out, in the same
 * transaction.
 *
 * Under `origin: "setup"` (GRA-206) the proposal is Setup's, written from a starter entry: the
 * model's provenance is not shown and the proposal editor sits behind *Edit the connection*,
 * closed until opened or until a refusal lands on one of its inputs. The hosts, the secret
 * inputs, the line for the integration's tools and the answer are the same card's; the build
 * choice is not drawn there and not sent (`lib/connection-choices.ts`, GRA-274).
 *
 * On the handoff page (`layout: "focused"`, GRA-314) the card asks the page's question, keeps the
 * secret's inputs in front, and offers *Full access / Ask me first* (`lib/access-choice.ts`) in
 * place of the two lines: the same two grants, both or neither. The proposal editor is behind
 * *Edit details*.
 */
export function ConnectionAskCard({
  ask,
  onAnswered,
  origin = "agent",
  setupFooter,
  layout = "card",
}: {
  ask: Extract<Ask, { kind: "connection" }>;
  onAnswered?: () => void;
  origin?: AskOrigin;
  /** The handoff page's `focused` (GRA-314); the class comment says what changes. */
  layout?: AskLayout;
  /** Under Setup's compact card: the task waiting on this connection. */
  setupFooter?: React.ReactNode;
}) {
  const { action, payload } = ask;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftFromProposal(payload));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [approveBuild, setApproveBuild] = useState(true);
  const [allowVendor, setAllowVendor] = useState(true);
  const [access, setAccess] = useState<AccessChoice>(DEFAULT_ACCESS_CHOICE);
  // Setup's disclosure over the proposal editor; outside Setup the editor is never folded.
  const [editing, setEditing] = useState(false);
  const agentName = action.agent?.name ?? "the agent";
  // What Connect carries: a line the card does not draw is never sent as a yes (GRA-274).
  const shown = connectionChoicesShown({ origin, widens: payload.widens != null });
  const sent =
    layout === "focused"
      ? accessChoiceSent(access, shown)
      : connectionChoicesSent(shown, { approveBuild, allowVendor });
  const decline = useAnswerAsk(action, onAnswered, origin);
  const consent = useOAuthConsent({
    onConnected: () => {
      toast.success(`${draft.displayName} is connected`, {
        description: connectedToastDescription({
          origin,
          agentName,
          approveBuild: sent.approveBuild,
          ...(sent.allowVendor ? { vendorTools: integrationName } : {}),
        }),
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
      queryClient.invalidateQueries({ queryKey: approvalKeys.vendorsOfAgent(action.agentId) });
      queryClient.invalidateQueries({ queryKey: approvalKeys.buildsOfAgent(action.agentId) });
      if (authorizeUrl) {
        toast.message(`${connection.displayName}'s client is saved`, {
          description:
            "Complete the consent in the popup; the agent is told once the tokens are stored.",
        });
        void consent.run(authorizeUrl, connection);
        return;
      }
      toast.success(`${connection.displayName} is connected`, {
        description: connectedToastDescription({
          origin,
          agentName,
          approveBuild: submitted.approveBuild,
          ...(submitted.allowVendor
            ? { vendorTools: integrationNameFor(connection.vendor, connection.displayName) }
            : {}),
        }),
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
          setEditing(true);
        }
      }
    },
  });

  const submit = () => {
    const verdict = validateConnectionDraft(draft);
    if (!verdict.ok) {
      setErrors(verdict.errors);
      // A problem outside the secret inputs is in the editor, so a folded editor opens to show it.
      if (Object.keys(verdict.errors).some((key) => !key.startsWith("credential"))) {
        setEditing(true);
      }
      return;
    }
    setErrors({});
    connect.mutate({ ...verdict.value, ...sent });
  };

  const open = isOpen(action);
  const hosts = hostsOf(draft) ?? payload.hosts;
  const oauth = isOAuthDraft(draft);
  const secret = secretLegend(draft);
  const provider: string = payload.provider ?? KEYRING_PROVIDER;
  const widens = payload.widens ?? null;
  const integrationName = integrationNameFor(draft.vendor, draft.displayName);
  // Once the client is saved and the popup is open, the form's job is done; the callback settles it.
  const consenting = consent.state.phase !== "idle" && consent.state.phase !== "done";
  const busy = connect.isPending || decline.isPending || consenting;
  const credentialFields = (
    <CredentialFields
      scheme={draft.scheme}
      value={draft.credential}
      onChange={(credential) => setDraft({ ...draft, credential })}
      errors={errors}
      idPrefix={`ask-${action.id}`}
      disabled={busy}
    />
  );

  // Setup v2's connect step: the app card, with only what the person must do on it (a secret to
  // paste, the line for the integration's tools, the consent popup's status, the folded editor),
  // never the build choice, which Setup's own build records (`startSetupBuild`) and Connect here
  // does not send (GRA-274), or the explanations the inbox card carries.
  if (origin === "setup" && !widens) {
    return (
      <AskCard
        action={action}
        title={payload.displayName}
        settled={(recorded) =>
          typeof recorded?.connectionId === "string"
            ? "Connected."
            : "Declined. Go back to choose again."
        }
        approveLabel={`Connect ${payload.displayName}`}
        pending={busy}
        onAnswer={(allow) => (allow ? submit() : decline.mutate({ allow: false }))}
        compact={{
          vendor: payload.vendor,
          name: payload.displayName,
          subline: oauth
            ? `Sign in to ${payload.displayName} in a popup`
            : secret
              ? `${secret}, entered here and never through your agent`
              : "A public API · nothing to sign in to, no key needed",
          footer: setupFooter,
        }}
      >
        {secret ? <FieldGroup>{credentialFields}</FieldGroup> : null}
        {shown.allowVendor ? (
          <VendorToolsItem
            id={`ask-${action.id}-allow-vendor`}
            integrationName={integrationName}
            checked={allowVendor}
            onCheckedChange={setAllowVendor}
            disabled={busy}
          />
        ) : null}
        {consent.state.phase === "idle" ? null : (
          <ConsentStatus state={consent.state} onCancel={consent.cancel} />
        )}
        {editing || Object.keys(errors).some((key) => !key.startsWith("credential")) ? (
          <FieldGroup>
            <ConnectionFormFields
              draft={draft}
              onChange={setDraft}
              errors={errors}
              idPrefix={`ask-${action.id}`}
              disabled={busy}
            />
          </FieldGroup>
        ) : null}
      </AskCard>
    );
  }

  // The handoff page (GRA-314): the question, the secret's inputs, *Full access / Ask me first*
  // in place of the two lines, and the proposal editor behind *Edit details*, opened by a refusal
  // that lands on one of its inputs.
  if (layout === "focused") {
    const asker = action.agent?.name ?? "Your agent";
    const editorOpen = editing || Object.keys(errors).some((key) => !key.startsWith("credential"));
    const finish = widens ? "widen" : oauth ? "consent" : secret ? "key" : "keyless";
    return (
      <AskCard
        action={action}
        title={null}
        settled={(recorded) =>
          typeof recorded?.connectionId === "string"
            ? connectedSettledSentence({ origin, widens: widens !== null })
            : "Declined. Nothing was created; the agent is told so."
        }
        approveLabel="Connect"
        pending={busy}
        onAnswer={(allow) => (allow ? submit() : decline.mutate({ allow: false }))}
        focused={{
          vendor: draft.vendor,
          integrationName,
          question: widens
            ? `Let ${payload.displayName} reach more for ${asker}?`
            : `Connect ${draft.displayName} for ${asker}?`,
          lead: proposalLead({
            agentName: asker,
            integrationName,
            docsUrl: payload.docsUrl,
            finish,
            addedHosts: widens?.addedHosts,
          }),
          summary: proposalSummary({
            primaryHost: draft.primaryHost,
            scheme: draft.scheme,
            integrationName,
            docsUrl: payload.docsUrl,
          }),
          secret: secret !== null,
          details: widens
            ? {
                label: "Details",
                content: (
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground">Adds</dt>
                    <dd>
                      <Hosts hosts={widens.addedHosts} />
                    </dd>
                    <dt className="text-muted-foreground">Will reach</dt>
                    <dd>
                      <Hosts hosts={payload.hosts} />
                    </dd>
                  </dl>
                ),
              }
            : {
                label: "Edit details",
                open: editorOpen,
                onOpenChange: setEditing,
                content: (
                  <>
                    <ProposalSource
                      origin={origin}
                      agentName={action.agent?.name ?? null}
                      note={payload.note}
                      docsUrl={payload.docsUrl}
                    />
                    <FieldGroup>
                      <ConnectionFormFields
                        draft={draft}
                        onChange={setDraft}
                        errors={errors}
                        idPrefix={`ask-${action.id}`}
                        disabled={busy}
                      />
                    </FieldGroup>
                    <HostsNotice draft={draft} />
                  </>
                ),
              },
        }}
      >
        {widens ? null : (
          <>
            <OAuthClientNotice draft={draft} />
            {secret ? (
              <FieldSet className="gap-1.5">
                <FieldGroup>{credentialFields}</FieldGroup>
                <SecretHint hosts={hosts} agentName={asker} />
              </FieldSet>
            ) : null}
          </>
        )}
        <ChoiceCards
          id={`ask-${action.id}-access`}
          legend={accessLegend(asker)}
          options={accessOptions(asker, integrationName)}
          value={access}
          onValueChange={setAccess}
          disabled={busy}
        />
        <ConsentStatus state={consent.state} onCancel={consent.cancel} />
      </AskCard>
    );
  }

  return (
    <AskCard
      action={action}
      title={
        <>
          <span className="text-muted-foreground">{widens ? "widen" : "connect"}</span>
          <span>{payload.displayName}</span>
          <Badge variant="outline">{payload.vendor}</Badge>
          {provider === KEYRING_PROVIDER ? null : (
            <Badge variant="outline">via {providerName(provider)}</Badge>
          )}
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
            {connectedSettledSentence({ origin, widens: widens !== null })}{" "}
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
      <ProposalSource
        origin={origin}
        agentName={action.agent?.name ?? null}
        note={payload.note}
        docsUrl={payload.docsUrl}
      />

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
          <VendorToolsItem
            id={`ask-${action.id}-allow-vendor`}
            integrationName={integrationName}
            checked={allowVendor}
            onCheckedChange={setAllowVendor}
            disabled={busy}
          />
        </>
      ) : open ? (
        <>
          {origin === "setup" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              aria-expanded={editing}
              onClick={() => setEditing((shown) => !shown)}
            >
              {editing ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
              Edit the connection
            </Button>
          ) : null}
          {origin !== "setup" || editing ? (
            <FieldSet>
              <FieldLegend variant="label">
                The connection as proposed: edit what is wrong
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
          ) : null}
          <HostsNotice draft={draft} />
          <OAuthClientNotice draft={draft} />
          {secret ? (
            <FieldSet>
              <FieldLegend variant="label">
                {secret}, entered here and never through the agent
              </FieldLegend>
              <FieldGroup>{credentialFields}</FieldGroup>
            </FieldSet>
          ) : (
            // A keyless scheme (GRA-66): the one sentence where the inputs would be, under no
            // heading about a secret (GRA-91).
            credentialFields
          )}
          <BuildApprovalItem
            id={`ask-${action.id}-approve-build`}
            agentName={agentName}
            checked={approveBuild}
            onCheckedChange={setApproveBuild}
            disabled={busy}
          />
          <VendorToolsItem
            id={`ask-${action.id}-allow-vendor`}
            integrationName={integrationName}
            checked={allowVendor}
            onCheckedChange={setAllowVendor}
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
