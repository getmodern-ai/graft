import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectionCalls } from "@/components/connection/connection-calls";
import { ConsentStatus } from "@/components/connection/oauth-client-notice";
import { ReenterCredentialDialog } from "@/components/connection/reenter-credential-dialog";
import { RevokeConnectionDialog } from "@/components/connection/revoke-connection-dialog";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import { KeyboardArrowDownIcon, KeyboardArrowUpIcon, WarningIcon } from "@/components/icons";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { agentKeys, type Tool } from "@/lib/agent-queries";
import {
  type Connection,
  connectionKeys,
  connectionStatus,
  isGatewayConnection,
  isKeyringConnection,
  providerLabel,
  reconnectConnection,
  retryProviderRelease,
  toolKeys,
} from "@/lib/connection-queries";
import { startOAuthConsent } from "@/lib/oauth-consent";
import {
  AWAITING_RECONNECTION_CHIP,
  connectionStatusChips,
  NO_PASSING_VERSION_CHIP,
} from "@/lib/status-chips";

/**
 * One connection: the vendor, the hosts the proxy pins its calls to, the scheme, when the credential
 * was set — and never the credential (CONTEXT.md: write-only after entry) — with the tools bound to
 * its vendor and its recent vendor calls. A revoked connection is still listed, awaiting
 * reconnection: its tools are, too, and Re-enter credential is the reconnection (ADR 0007; GRA-28).
 * A tool with no current version — every version an `acquire` job published failed its dry run
 * (GRA-77) — is listed with a chip saying so; it is in the toolbox and in no agent's list.
 *
 * An OAuth connection (ADR 0005) has two more states between the secret and connected: the client
 * secret entered and the consent not yet completed, and a refresh the vendor refused so the person
 * has to consent again. Both are one button — Connect, Reconnect — that starts the consent in a
 * popup with the client secret already in place; the secret is asked for again only after a revoke.
 *
 * A connection from another provider (ADR 0019) wears the provider's name and says its credential
 * is held there; the credential buttons are the keyring's alone, since there is nothing here to
 * enter. A connection through the person's API gateway (GRA-58) was made with no person step, and
 * its one button beyond Revoke is Reconnect on a revoked row — nothing to enter, the stamp cleared,
 * the approvals still gone. A connection through a link provider (GRA-59) comes back through the
 * provider's own link; when its release failed on a revoke, the card says the account is still at
 * the provider and offers Retry release. With the keyring alone, nothing on this card changed for
 * providers.
 *
 * A card rather than a table row, because each connection carries a status, a host list, a tool
 * list, two actions and a table of its own — more than a row can hold. The anatomy is Cando's
 * card: title and chips, description, the actions in `CardAction`, and the facts in the body. The
 * recent calls are a disclosure at the end of the body, not the `CardFooter` they used to sit in:
 * the footer is Cando's banded action strip, `bg-muted/50` over a rule, and a table drawn on that
 * band loses its own row hover (the same `bg-muted/50`) and reads as furniture rather than data.
 */
export function ConnectionCard({ connection, tools }: { connection: Connection; tools: Tool[] }) {
  const [showCalls, setShowCalls] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [reentering, setReentering] = useState(false);
  const queryClient = useQueryClient();
  const status = connectionStatus(connection);
  const usable = status === "connected";
  const keyring = isKeyringConnection(connection);
  const gateway = isGatewayConnection(connection);
  // A `none` connection has no credential to enter or re-enter (GRA-66): no primary action while
  // it stands, and Reconnect — the gateway's route — after a revoke.
  const keyless = keyring && connection.scheme === "none";
  const consent = useOAuthConsent({
    onConnected: () => toast.success(`${connection.displayName} is connected`),
  });
  const reconsent = useMutation({
    mutationFn: () => startOAuthConsent(connection.id),
    onSuccess: ({ authorizeUrl }) => void consent.run(authorizeUrl, connection),
  });
  const consenting = reconsent.isPending || consent.running;
  const reconnect = useMutation({
    mutationFn: () => reconnectConnection(connection.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: toolKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success(`${connection.displayName} is reconnected`, {
        description: keyless
          ? "The vendor is called as-is again. The approvals the revoke removed stay removed; each tool asks again."
          : "Every call relays through your API gateway again. The approvals the revoke removed stay removed; each tool asks again.",
      });
    },
  });
  /**
   * The provider's release failed on the revoke and the account is still at the provider
   * (ADR 0019); the row says so until a retry succeeds, and this is that retry.
   */
  const release = useMutation({
    mutationFn: () => retryProviderRelease(connection.id),
    onSuccess: ({ providerRelease }) => {
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      if (providerRelease.released) {
        toast.success(`${providerRelease.provider} released ${connection.displayName}`, {
          description:
            "The account is gone at the provider; nothing about it is held anywhere now.",
        });
      } else {
        toast.warning(`${providerRelease.provider} still did not release the connection`, {
          description: "The provider could not be reached; the card keeps offering Retry.",
        });
      }
    },
  });

  const description = {
    revoked: gateway ? (
      <>
        Revoked <Time iso={connection.revokedAt ?? ""} />. Every approval is cleared with it and no
        call relays through your API gateway until you reconnect it; nothing was stored here to
        clear.
      </>
    ) : !keyring ? (
      <>
        Revoked <Time iso={connection.revokedAt ?? ""} />. The account at {connection.provider} is
        forgotten and every approval with it; when an agent asks to connect {connection.vendor}{" "}
        again, one click through {connection.provider} reconnects it.
      </>
    ) : (
      <>
        Revoked <Time iso={connection.revokedAt ?? ""} />. The credential is cleared and every
        approval with it;{" "}
        {connection.oauth
          ? "entering the client secret and consenting again"
          : "re-entering a credential"}{" "}
        reconnects it.
      </>
    ),
    awaiting_credential: (
      <>Registered, no {connection.oauth ? "client secret" : "credential"} entered yet.</>
    ),
    awaiting_consent: (
      <>Client secret set; the vendor's consent has not been completed. Connect opens it.</>
    ),
    consent_required: (
      <>
        The vendor refused to refresh the token
        {connection.oauth?.consentRequired ? (
          <>
            {" "}
            <Time iso={connection.oauth.consentRequired.at} />
          </>
        ) : null}
        ; consent again to keep the tools working.
      </>
    ),
    connected: gateway ? (
      <>
        Connected through your API gateway with no person step: it holds the vendor credential and
        receives every call, and nothing is entered or stored here.
      </>
    ) : !keyring ? (
      <>
        Connected through {connection.provider}. The account's token is held there, never here;
        Graft stores only the account's id, and every call relays through {connection.provider}.
      </>
    ) : connection.oauth ? (
      <>
        Consented <Time iso={connection.oauth.consentedAt ?? connection.credentialSetAt ?? ""} />
        {connection.oauth.refreshedAt ? (
          <>
            , token refreshed <Time iso={connection.oauth.refreshedAt} />
          </>
        ) : null}
        . Tokens are never shown.
      </>
    ) : (
      <>
        Credential set <Time iso={connection.credentialSetAt ?? ""} />. Never shown again.
      </>
    ),
  }[status];

  // Which button, and what it does: a consent alone when the client secret is in place, the
  // credential dialog otherwise (which for an OAuth connection runs the consent after the secret).
  const primary =
    connection.oauth && (status === "awaiting_consent" || status === "consent_required")
      ? {
          label: status === "consent_required" ? "Reconnect" : "Connect",
          onClick: () => reconsent.mutate(),
        }
      : {
          label:
            status === "revoked"
              ? "Reconnect"
              : status === "awaiting_credential"
                ? connection.oauth
                  ? "Enter client secret"
                  : "Enter credential"
                : connection.oauth
                  ? "Re-enter client secret"
                  : "Re-enter credential",
          onClick: () => setReentering(true),
        };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {connection.displayName}
          <Badge variant="outline">{connection.vendor}</Badge>
          {keyring ? null : <Badge variant="outline">{providerLabel(connection)}</Badge>}
          <Badge variant="outline">{connection.scheme}</Badge>
          {connectionStatusChips(connection, status).map((chip) => (
            <StatusChip key={chip.label} chip={chip} />
          ))}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction className="flex gap-2">
          {keyring && !keyless ? (
            <Button
              variant={usable ? "outline" : "default"}
              size="sm"
              disabled={consenting}
              onClick={primary.onClick}
            >
              {consenting ? "Waiting for the consent…" : primary.label}
            </Button>
          ) : null}
          {(gateway || keyless) && status === "revoked" ? (
            <Button size="sm" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>
              {reconnect.isPending ? "Reconnecting…" : "Reconnect"}
            </Button>
          ) : null}
          {status === "revoked" ? null : (
            <Button variant="outline" size="sm" onClick={() => setRevoking(true)}>
              Revoke
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <ConsentStatus state={consent.state} onCancel={consent.cancel} />
        {connection.providerReleaseFailedAt ? (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>{connection.provider} still holds this account</AlertTitle>
            <AlertDescription>
              <p>
                Everything in Graft is revoked, but {connection.provider} could not be asked to
                release the account when you revoked (
                <Time iso={connection.providerReleaseFailedAt} />
                ). Until it does, the account is still connected there.
              </p>
              <p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={release.isPending}
                  onClick={() => release.mutate()}
                >
                  {release.isPending ? "Retrying…" : "Retry release"}
                </Button>
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Hosts</dt>
          <dd className="flex flex-wrap gap-1.5">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {connection.primaryHost}
            </code>
            {connection.hosts
              .filter((host) => !connection.primaryHost.includes(host))
              .map((host) => (
                <code key={host} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {host}
                </code>
              ))}
          </dd>
          {Object.keys(connection.schemeConfig).length > 0 ? (
            <>
              <dt className="text-muted-foreground">Scheme parameters</dt>
              <dd className="flex flex-wrap gap-1.5">
                {Object.entries(connection.schemeConfig).map(([key, value]) => (
                  <code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {key}={value}
                  </code>
                ))}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Tools</dt>
          <dd>
            {tools.length === 0 ? (
              <span className="text-muted-foreground">
                None authored against {connection.vendor} yet.
              </span>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {tools.map((tool) => (
                  <li key={tool.id} className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs">
                      {tool.vendor}__{tool.name}
                    </code>
                    <ToolAnnotations readOnly={tool.readOnly} destructive={tool.destructive} />
                    {tool.currentVersionId === null ? (
                      <StatusChip chip={NO_PASSING_VERSION_CHIP} />
                    ) : null}
                    {usable ? null : <StatusChip chip={AWAITING_RECONNECTION_CHIP} />}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </CardContent>
      <CardContent className="flex flex-col gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          aria-expanded={showCalls}
          onClick={() => setShowCalls((open) => !open)}
        >
          {showCalls ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
          Recent vendor calls
        </Button>
        {showCalls ? <ConnectionCalls connectionId={connection.id} /> : null}
      </CardContent>

      <RevokeConnectionDialog connection={connection} open={revoking} onOpenChange={setRevoking} />
      {keyring ? (
        <ReenterCredentialDialog
          key={`${connection.id}:${connection.credentialSetAt ?? "none"}`}
          connection={connection}
          open={reentering}
          onOpenChange={setReentering}
        />
      ) : null}
    </Card>
  );
}
