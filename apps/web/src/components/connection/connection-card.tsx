import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";

import { ConnectionCalls } from "@/components/connection/connection-calls";
import { RevokeConnectionDialog } from "@/components/connection/revoke-connection-dialog";
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
import { type Connection, isAwaitingCredential } from "@/lib/connection-queries";

/**
 * One connection: the vendor, the hosts the proxy pins its calls to, the scheme, when the credential
 * was set — and never the credential (CONTEXT.md: write-only after entry) — with the tools bound to
 * its vendor and its recent vendor calls. A revoked connection is still listed: its tools are, too,
 * awaiting reconnection (ADR 0007).
 */
export function ConnectionCard({ connection, tools }: { connection: Connection; tools: Tool[] }) {
  const [showCalls, setShowCalls] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const awaiting = isAwaitingCredential(connection);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {connection.displayName}
          <Badge variant="outline">{connection.vendor}</Badge>
          <Badge variant="outline">{connection.scheme}</Badge>
          {connection.revokedAt ? (
            <Badge variant="destructive">revoked</Badge>
          ) : awaiting ? (
            <Badge variant="outline">no credential yet</Badge>
          ) : (
            <Badge variant="secondary">connected</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {connection.revokedAt ? (
            <>
              Revoked <Time iso={connection.revokedAt} />. The credential is cleared; its tools
              await reconnection.
            </>
          ) : connection.credentialSetAt ? (
            <>
              Credential set <Time iso={connection.credentialSetAt} />.
            </>
          ) : (
            <>Registered, no credential entered yet.</>
          )}
        </CardDescription>
        <CardAction>
          {connection.revokedAt ? null : (
            <Button variant="outline" size="sm" onClick={() => setRevoking(true)}>
              Revoke
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
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
                    {awaiting ? <Badge variant="outline">awaiting reconnection</Badge> : null}
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
          {showCalls ? <ChevronUpIcon /> : <ChevronDownIcon />}
          Recent vendor calls
        </Button>
        {showCalls ? <ConnectionCalls connectionId={connection.id} /> : null}
      </CardFooter>

      <RevokeConnectionDialog connection={connection} open={revoking} onOpenChange={setRevoking} />
    </Card>
  );
}
