import type { AgentScopeMode, AuthorizationRequestParams } from "@graft/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { ScopeModeField } from "@/components/agent/scope-mode-field";
import { WarningIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Agent } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";
import {
  consentCardTitle,
  judgeConsentClient,
  UNVOUCHED_CLIENT_NOTICE,
} from "@/lib/consent-client";
import { type ConsentRequest, decideConsent } from "@/lib/mcp-oauth-queries";

/** The one option that is not an agent: mint a new one, named for the client. */
const NEW_AGENT = "new";

/**
 * The consent (ADR 0006: the console is where a consent happens; ADR 0018: the consent mints the
 * agent). One card: who is asking, by the name it registered, and where it will be sent back; then
 * the agent the connection will *be* — a new one, prefilled with the client's name, on every
 * connection of the person's unless they limit it to a list (ADR 0007 as amended 2026-09-19), or
 * one the person already has. Connect binds a code to that agent and sends the browser back to the
 * client; Cancel sends it back with `access_denied`. Either way the browser leaves this page, so
 * the card has no settled state of its own.
 *
 * Composed from the create-agent dialog's form (`create-agent-dialog.tsx`) — the same name field,
 * the same scope field (`scope-mode-field.tsx`) with the same skeleton while connections load —
 * inside a `Card` rather than a `Dialog`, because this screen is the page: the browser arrived
 * here from another product and has nowhere else to be. The choice between a new agent and an
 * existing one is the `Select` primitive with `items` on the root, as every fixed choice in the
 * console is (AGENTS.md).
 *
 * **A client the deployment does not vouch for is said to be one** (ADR 0018 as amended
 * 2026-09-22): the notice above the form, the name in the title as the app's own claim, and the
 * scope starting at `Selected connections` with nothing ticked. The verdict is one function over
 * the server's description (`lib/consent-client.ts`), and for a vouched client the card is what it
 * was.
 */
export function ConsentCard({
  request,
  params,
  connections,
  connectionsFailed,
  agents,
  agentsFailed,
}: {
  request: ConsentRequest;
  /** The authorization request as the browser arrived with it; sent back with the decision. */
  params: AuthorizationRequestParams;
  /** The person's connections, or `undefined` while the read is pending or has failed. */
  connections: readonly Connection[] | undefined;
  connectionsFailed?: { error: unknown; onRetry: () => void; retrying: boolean };
  /** The person's agents, or `undefined` while the read is pending or has failed; a revoked one is not offered. */
  agents: readonly Agent[] | undefined;
  agentsFailed?: { error: unknown; onRetry: () => void; retrying: boolean };
}) {
  const client = request.client.name;
  // Whether Graft's deployment vouches for the client, and what the page does about it. Read from
  // the description the server answered with, so the page applies no rule of its own.
  const verdict = judgeConsentClient(request);
  const [as, setAs] = useState<string>(NEW_AGENT);
  const [name, setName] = useState(client);
  const [scopeMode, setScopeMode] = useState<AgentScopeMode>(verdict.defaultScopeMode);
  const [scope, setScope] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState(false);

  const active = (agents ?? []).filter((agent) => agent.revokedAt === null);
  const items = [
    { value: NEW_AGENT, label: "A new agent" },
    ...active.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const decide = useMutation({
    mutationFn: decideConsent,
    onSuccess: (outcome) => {
      // The client's redirect URI, with the code or the error: the browser goes back to the product.
      setLeaving(true);
      window.location.assign(outcome.redirectTo);
    },
  });

  const minting = as === NEW_AGENT;
  const busy = decide.isPending || leaving;
  // Connect waits for the agents read, and under `Limit to these` for the connections too: a scope
  // chosen from a list that has not arrived would be an empty one nobody chose, and a choice
  // offered from an agent list that has not arrived would hide the agents the person already has
  // (the create dialog holds Create the same way). Under `All connections` nothing is chosen from
  // the list.
  const canConnect =
    !busy &&
    agents !== undefined &&
    (minting ? name.trim().length > 0 && (scopeMode === "all" || connections !== undefined) : true);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{consentCardTitle(client, verdict.vouched)}</CardTitle>
        <CardDescription>
          {client} asked to connect over MCP. It will act as one agent of yours — with that agent's
          scope, working set and approvals — and when you connect it is sent back to{" "}
          <code className="font-mono text-xs">{request.redirectTarget}</code>.
          {/* Where this client's asks will reach you (ADR 0006 as amended 2026-09-21): the gate is
              the callback host it registered, and the server has judged it (`rendersCards`). */}
          {request.rendersCards ? (
            <>
              {" "}
              {client} can show Graft's approval cards in this chat and record your answers from
              them; everything else still opens in the console.
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          id="consent"
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canConnect) return;
            decide.mutate({
              request: params,
              decision: "allow",
              agent: minting
                ? {
                    kind: "new",
                    name: name.trim(),
                    scopeMode,
                    ...(scopeMode === "listed" ? { connectionIds: [...scope] } : {}),
                  }
                : { kind: "existing", agentId: as },
            });
          }}
        >
          <FieldGroup>
            {verdict.showsNotice ? <UnvouchedClientNotice host={verdict.callbackHost} /> : null}
            <Field>
              <FieldLabel htmlFor="consent-as">Connect as</FieldLabel>
              <Select
                value={as}
                items={items}
                disabled={busy || agents === undefined}
                onValueChange={(next) => {
                  if (typeof next === "string") setAs(next);
                }}
              >
                <SelectTrigger id="consent-as" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {agents === undefined ? (
                  agentsFailed ? (
                    <RetryNotice
                      error={agentsFailed.error}
                      message="Could not load your agents."
                      onRetry={agentsFailed.onRetry}
                      retrying={agentsFailed.retrying}
                    />
                  ) : (
                    "Loading your agents…"
                  )
                ) : minting ? (
                  "A new agent, made for this connection. You can rename it and change its scope any time."
                ) : (
                  "An agent you already have. Its scope, working set and approvals apply as they are."
                )}
              </FieldDescription>
            </Field>

            {minting ? (
              <>
                <Field>
                  <FieldLabel htmlFor="consent-name">Name</FieldLabel>
                  <Input
                    id="consent-name"
                    required
                    disabled={busy}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <FieldDescription>
                    How the agent appears in the console; {client} is recorded as where it came
                    from.
                  </FieldDescription>
                </Field>
                <ScopeModeField
                  id="consent-scope"
                  mode={scopeMode}
                  onModeChange={setScopeMode}
                  selected={scope}
                  onSelectedChange={setScope}
                  connections={connections}
                  connectionsFailed={connectionsFailed}
                  disabled={busy}
                />
              </>
            ) : null}

            {decide.isError ? (
              <FieldError>
                {decide.error instanceof Error ? decide.error.message : "Could not connect."}
              </FieldError>
            ) : null}
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => decide.mutate({ request: params, decision: "deny" })}
        >
          Cancel
        </Button>
        <Button type="submit" form="consent" disabled={!canConnect}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * The notice above the form for a client the deployment does not vouch for (ADR 0018 as amended
 * 2026-09-22). An `Alert`, as every notice inside a form in this console is (AGENTS.md), and the
 * callback host on a line of its own: it is the one fact in the card that the registrant could not
 * choose freely, and the only one that tells the person whether the app asking is the app they
 * started from. The words are `lib/consent-client.ts`'s, tested there.
 */
function UnvouchedClientNotice({ host }: { host: string }) {
  return (
    <Alert>
      <WarningIcon />
      <AlertTitle>{UNVOUCHED_CLIENT_NOTICE.title}</AlertTitle>
      <AlertDescription>
        <p>{UNVOUCHED_CLIENT_NOTICE.registered}</p>
        <p className="break-all font-medium font-mono text-base text-foreground">{host}</p>
        <p>{UNVOUCHED_CLIENT_NOTICE.started}</p>
      </AlertDescription>
    </Alert>
  );
}
