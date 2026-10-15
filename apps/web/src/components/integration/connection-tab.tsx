import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";

import { ConsentStatus } from "@/components/connection/oauth-client-notice";
import { ReenterCredentialDialog } from "@/components/connection/reenter-credential-dialog";
import { RevokeConnectionDialog } from "@/components/connection/revoke-connection-dialog";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import {
  AccountCircleIcon,
  CheckCircleIcon,
  KeyboardArrowDownIcon,
  KeyboardArrowUpIcon,
  KeyIcon,
  LanguageIcon,
  LockIcon,
  PowerIcon,
  RefreshIcon,
  ScheduleIcon,
  WarningIcon,
} from "@/components/icons";
import { SettingsCard, SettingsRowGroup } from "@/components/settings/settings-card";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { isKeyringConnection } from "@/lib/connection-queries";
import {
  connectedThroughLabel,
  connectionAccountOf,
  loginHolderLine,
  oauthScopesOf,
  type PageConnection,
  reconnectActionsOf,
  schemeParametersOf,
} from "@/lib/integration-page";
import { startOAuthConsent } from "@/lib/oauth-consent";
import { providerLabel } from "@/lib/provider-name";
import { connectionStateChip } from "@/lib/status-chips";

/**
 * The integration page's Connection tab (GRA-315; Figma 2095:11814): for each connection of the
 * vendor, what it is and where its calls go on the left, and what the person can do about it on
 * the right — sign in again through the connections card's own flows (re-consent, re-enter the
 * credential; ADR 0005, ADR 0007) and revoke through its own dialog, with today's consequences.
 * One page per integration, listing its connections (GRA-287 item 1), so several connections of
 * one vendor are drawn one after another, each titled and each with its own actions.
 *
 * A revoked connection is read-only here: its facts, and the way back on the connections screen,
 * which still reconnects a revoked row (GRA-291's note).
 */
export function ConnectionTab({
  connections,
  integrationName,
}: {
  connections: PageConnection[];
  /** The integration's name, for the copy about its tools; a connection's own name may be an account's. */
  integrationName: string;
}) {
  const several = connections.length > 1;
  return (
    <div className="flex flex-col gap-10">
      {connections.map((connection) => (
        <ConnectionPanel
          key={connection.id}
          connection={connection}
          integrationName={integrationName}
          titled={several}
        />
      ))}
    </div>
  );
}

function ConnectionPanel({
  connection,
  integrationName,
  titled,
}: {
  connection: PageConnection;
  integrationName: string;
  titled: boolean;
}) {
  const [details, setDetails] = useState(false);
  const scopes = oauthScopesOf(connection);
  const parameters = schemeParametersOf(connection);
  const revoked = connection.state === "revoked";
  const account = connectionAccountOf(connection);
  // With several connections each panel carries its name as an `h2` and its sections step down.
  const Section = titled ? "h3" : "h2";

  return (
    <section
      aria-labelledby={titled ? `connection-${connection.id}` : undefined}
      className="flex flex-col gap-6"
    >
      {titled ? (
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={`connection-${connection.id}`} className="font-medium text-xl">
            {connection.displayName}
          </h2>
          <StatusChip chip={connectionStateChip(connection, connection.state)} />
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22.5rem]">
        <div className="flex min-w-0 flex-col gap-10">
          <PanelSection
            as={Section}
            title="Account"
            description={`How Graft signs in to ${connection.displayName} for your agents.`}
          >
            <SettingsCard>
              <SettingsRowGroup>
                {titled ? null : (
                  <FactRow icon={<CheckCircleIcon />} label="Status">
                    <StatusChip chip={connectionStateChip(connection, connection.state)} />
                  </FactRow>
                )}
                {account ? (
                  <FactRow icon={<AccountCircleIcon />} label="Signed in as">
                    <span className="break-all">{account}</span>
                  </FactRow>
                ) : null}
                <FactRow icon={<PowerIcon />} label="Connected through">
                  {connectedThroughLabel(connection)}
                </FactRow>
                <FactRow icon={<ScheduleIcon />} label="Connected">
                  <Time iso={connection.createdAt} />
                </FactRow>
                {connection.oauth?.consentedAt ? (
                  <FactRow icon={<ScheduleIcon />} label="Signed in">
                    <Time iso={connection.oauth.consentedAt} />
                  </FactRow>
                ) : null}
                {connection.oauth?.refreshedAt ? (
                  <FactRow icon={<RefreshIcon />} label="Login last refreshed">
                    <Time iso={connection.oauth.refreshedAt} />
                  </FactRow>
                ) : null}
                {!connection.oauth && connection.credentialSetAt ? (
                  <FactRow icon={<KeyIcon />} label="Credential set">
                    <Time iso={connection.credentialSetAt} />
                  </FactRow>
                ) : null}
                {connection.revokedAt ? (
                  <FactRow icon={<ScheduleIcon />} label="Revoked">
                    <Time iso={connection.revokedAt} />
                  </FactRow>
                ) : null}
                <FactRow icon={<LockIcon />} label="Your login">
                  {loginHolderLine(connection)}
                </FactRow>
              </SettingsRowGroup>
            </SettingsCard>
          </PanelSection>

          <PanelSection
            as={Section}
            title={`Where ${connection.displayName} calls go`}
            description={`Graft only sends ${connection.displayName} requests to these addresses, and refuses anything else.`}
          >
            <SettingsCard>
              <SettingsRowGroup>
                {connection.hosts.map((host, index) => (
                  <FactRow
                    key={host}
                    icon={<LanguageIcon />}
                    label={index === 0 ? "Address" : "Also"}
                  >
                    <code className="break-all font-mono text-sm">{host}</code>
                  </FactRow>
                ))}
              </SettingsRowGroup>
            </SettingsCard>
          </PanelSection>

          <div className="flex flex-col gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2.5 self-start"
              aria-expanded={details}
              onClick={() => setDetails((open) => !open)}
            >
              {details ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
              Technical details
            </Button>
            {details ? (
              <SettingsCard>
                <SettingsRowGroup>
                  <FactRow label="Scheme">
                    <code className="font-mono text-sm">{connection.scheme}</code>
                  </FactRow>
                  {connection.provider !== "keyring" ? (
                    <FactRow label="Provider">
                      <code className="font-mono text-sm">{connection.provider}</code>
                    </FactRow>
                  ) : null}
                  {parameters.map(([key, value]) => (
                    <FactRow key={key} label={key}>
                      <code className="break-all font-mono text-sm">{value}</code>
                    </FactRow>
                  ))}
                  {scopes.length > 0 ? (
                    <FactRow label="Scopes">
                      <ul className="flex flex-col gap-1">
                        {scopes.map((scope) => (
                          <li key={scope}>
                            <code className="break-all font-mono text-sm">{scope}</code>
                          </li>
                        ))}
                      </ul>
                    </FactRow>
                  ) : null}
                </SettingsRowGroup>
              </SettingsCard>
            ) : null}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-10">
          {revoked ? (
            <RevokedSide connection={connection} as={Section} />
          ) : (
            <>
              <ReconnectSide connection={connection} as={Section} />
              <RevokeSide connection={connection} integrationName={integrationName} as={Section} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** A section's title and sentence over its card, as the frame's "Section header" draws it. */
function PanelSection({
  as: Heading,
  title,
  description,
  children,
}: {
  as: "h2" | "h3";
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <Heading className="font-medium text-lg">{title}</Heading>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** One fact: a glyph, a muted label in a fixed column, the value. Stacks below `sm`. */
function FactRow({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-3">
      <div className="flex shrink-0 items-center gap-3 text-muted-foreground sm:w-48 [&_svg]:size-4">
        {icon}
        <span>{label}</span>
      </div>
      <div className="min-w-0 flex-1 text-foreground">{children}</div>
    </div>
  );
}

/**
 * Sign in again, by the connections card's rules (`reconnectActionsOf`): a consent in a popup
 * where the client secret is in place, the credential dialog otherwise. Nothing for a row with
 * nothing to enter here (a gateway, a link provider, a keyless row).
 */
function ReconnectSide({ connection, as }: { connection: PageConnection; as: "h2" | "h3" }) {
  const [reentering, setReentering] = useState(false);
  const actions = reconnectActionsOf(connection, connection.state);
  const consent = useOAuthConsent({
    onConnected: () => toast.success(`${connection.displayName} is connected`),
  });
  const reconsent = useMutation({
    mutationFn: () => startOAuthConsent(connection.id),
    onSuccess: ({ authorizeUrl }) => void consent.run(authorizeUrl, connection),
  });
  const consenting = reconsent.isPending || consent.running;
  if (actions.length === 0) return null;
  const waiting = connection.state !== "connected";

  return (
    <PanelSection
      as={as}
      title={waiting ? "Finish connecting" : "Sign in again"}
      description={
        waiting
          ? `Your agents can't use ${connection.displayName} until you do.`
          : `Use this if ${connection.displayName} stops working.`
      }
    >
      <Card className="gap-0 py-0">
        <CardContent className="flex flex-col gap-3 py-4">
          <p>Your tools, agents and answers stay as they are.</p>
          <ConsentStatus state={consent.state} onCancel={consent.cancel} />
        </CardContent>
        <CardFooter className="flex-wrap gap-2 px-4 py-3">
          {actions.map((action) => (
            <Button
              key={action.kind}
              variant="outline"
              size="sm"
              disabled={consenting}
              onClick={() => (action.kind === "consent" ? reconsent.mutate() : setReentering(true))}
            >
              {action.kind === "consent" ? <RefreshIcon /> : <KeyIcon />}
              {action.kind === "consent" && consenting ? "Waiting for the consent…" : action.label}
            </Button>
          ))}
        </CardFooter>
      </Card>
      {isKeyringConnection(connection) ? (
        <ReenterCredentialDialog
          key={`${connection.id}:${connection.credentialSetAt ?? "none"}`}
          connection={connection}
          open={reentering}
          onOpenChange={setReentering}
        />
      ) : null}
    </PanelSection>
  );
}

/** Revoke, through the connections card's own dialog, which states today's consequences (ADR 0007). */
function RevokeSide({
  connection,
  integrationName,
  as,
}: {
  connection: PageConnection;
  integrationName: string;
  as: "h2" | "h3";
}) {
  const [revoking, setRevoking] = useState(false);
  const name = connection.displayName;
  return (
    <PanelSection
      as={as}
      title={`Revoke ${name}`}
      description={`Every agent loses ${name} straight away.`}
    >
      <Card className="gap-0 py-0">
        <CardContent className="py-4">
          <p>
            Your answers for {integrationName} tools are cleared and any open requests about this
            connection close. Your tools are kept in case you reconnect.
          </p>
        </CardContent>
        <CardFooter className="px-4 py-3">
          <Button variant="destructive" size="sm" onClick={() => setRevoking(true)}>
            Revoke {name}
          </Button>
        </CardFooter>
      </Card>
      <RevokeConnectionDialog connection={connection} open={revoking} onOpenChange={setRevoking} />
    </PanelSection>
  );
}

/** A revoked row: when, what the provider may still hold, and where it is reconnected. */
function RevokedSide({ connection, as }: { connection: PageConnection; as: "h2" | "h3" }) {
  return (
    <PanelSection
      as={as}
      title="Revoked"
      description={`No agent can use ${connection.displayName} through this connection.`}
    >
      <Card className="gap-0 py-0">
        <CardContent className="flex flex-col gap-3 py-4">
          <p>
            Revoked <Time iso={connection.revokedAt ?? ""} />. Its tools are kept and ask again once
            it is reconnected.
          </p>
          {connection.providerReleaseFailedAt ? (
            <Alert variant="destructive">
              <WarningIcon />
              <AlertTitle>{providerLabel(connection.provider)} still holds this account</AlertTitle>
              <AlertDescription>
                It could not be asked to release the account when you revoked. Retry release on the
                connections screen.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/connections" />}
          >
            Open connections
          </Button>
        </CardFooter>
      </Card>
    </PanelSection>
  );
}
