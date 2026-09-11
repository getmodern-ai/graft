import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectionCalls } from "@/components/connection/connection-calls";
import { ConsentStatus } from "@/components/connection/oauth-client-notice";
import { ReenterCredentialDialog } from "@/components/connection/reenter-credential-dialog";
import { RevokeConnectionDialog } from "@/components/connection/revoke-connection-dialog";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import { KeyboardArrowDownIcon, KeyboardArrowUpIcon } from "@/components/icons";
import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Tool } from "@/lib/agent-queries";
import { type Connection, connectionStatus } from "@/lib/connection-queries";
import { startOAuthConsent } from "@/lib/oauth-consent";

/**
 * One connection: the vendor, the hosts the proxy pins its calls to, the scheme, when the credential
 * was set — and never the credential (CONTEXT.md: write-only after entry) — with the tools bound to
 * its vendor and its recent vendor calls. A revoked connection is still listed, awaiting
 * reconnection: its tools are, too, and Re-enter credential is the reconnection (ADR 0007; GRA-28).
 *
 * An OAuth connection (ADR 0005) has two more states between the secret and connected: the client
 * secret entered and the consent not yet completed, and a refresh the vendor refused so the person
 * has to consent again. Both are one button — Connect, Reconnect — that starts the consent in a
 * popup with the client secret already in place; the secret is asked for again only after a revoke.
 */
export function ConnectionCard({ connection, tools }: { connection: Connection; tools: Tool[] }) {
  const [showCalls, setShowCalls] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [reentering, setReentering] = useState(false);
  const status = connectionStatus(connection);
  const usable = status === "connected";
  const consent = useOAuthConsent({
    onConnected: () => toast.success(`${connection.displayName} is connected`),
  });
  const reconsent = useMutation({
    mutationFn: () => startOAuthConsent(connection.id),
    onSuccess: ({ authorizeUrl }) => void consent.run(authorizeUrl, connection),
  });
  const consenting = reconsent.isPending || consent.running;

  const badge = {
    revoked: (
      <>
        <Badge variant="destructive">revoked</Badge>
        <Badge variant="outline">awaiting reconnection</Badge>
      </>
    ),
    awaiting_credential: (
      <Badge variant="outline">
        {connection.oauth ? "awaiting client secret" : "awaiting credential"}
      </Badge>
    ),
    awaiting_consent: <Badge variant="outline">awaiting consent</Badge>,
    consent_required: <Badge variant="destructive">needs re-consent</Badge>,
    connected: <Badge variant="success">connected</Badge>,
  }[status];

  const description = {
    revoked: (
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
    connected: connection.oauth ? (
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
          <Badge variant="outline">{connection.scheme}</Badge>
          {badge}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction className="flex gap-2">
          <Button
            variant={usable ? "outline" : "default"}
            size="sm"
            disabled={consenting}
            onClick={primary.onClick}
          >
            {consenting ? "Waiting for the consent…" : primary.label}
          </Button>
          {status === "revoked" ? null : (
            <Button variant="outline" size="sm" onClick={() => setRevoking(true)}>
              Revoke
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <ConsentStatus state={consent.state} onCancel={consent.cancel} />
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
                    {usable ? null : <Badge variant="outline">awaiting reconnection</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShowCalls((open) => !open)}
        >
          {showCalls ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
          Recent vendor calls
        </Button>
        {showCalls ? <ConnectionCalls connectionId={connection.id} /> : null}
      </CardFooter>

      <RevokeConnectionDialog connection={connection} open={revoking} onOpenChange={setRevoking} />
      <ReenterCredentialDialog
        key={`${connection.id}:${connection.credentialSetAt ?? "none"}`}
        connection={connection}
        open={reentering}
        onOpenChange={setReentering}
      />
    </Card>
  );
}
