import { readAuthorizationRequestParams } from "@graft/core/mcp-oauth/mcp-oauth.rules";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type * as React from "react";

import { ConsentCard } from "@/components/agent/consent-card";
import { DangerousIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { PageContainer } from "@/components/page/page-container";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { agentsQuery } from "@/lib/agent-queries";
import { ApiError } from "@/lib/api";
import { connectionsQuery } from "@/lib/connection-queries";
import { consentRequestQuery } from "@/lib/mcp-oauth-queries";

/**
 * Where the authorization endpoint sends the browser (ADR 0018; `apps/server/src/mcp-oauth.ts`):
 * `/consent?client_id=…&redirect_uri=…&code_challenge=…`, the OAuth request as the product made
 * it, carried whole so the server can judge it again at the decision. Under the guard, so a
 * signed-out person signs in and comes straight back (ADR 0006) — which is how a chat product's
 * "connect" reaches a person with no session yet — and under the shell, because this is a screen
 * of the console like any other.
 *
 * The server describes the request first: a client or a redirect URI it cannot vouch for is a
 * refusal page with nothing to press, in the shape the handoff refusal takes (`pending.$id.tsx`),
 * and the browser is never sent anywhere. A sound request is the card.
 */
export const Route = createFileRoute("/_auth/_shell/consent")({
  validateSearch: (search: Record<string, unknown>) => readAuthorizationRequestParams(search),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(connectionsQuery);
    void context.queryClient.prefetchQuery(agentsQuery);
  },
  component: ConsentRoute,
});

/** The refusal's headline by the server's `details.reason` — the words a person can act on. */
function refusalOf(error: unknown): { title: string; message: string } {
  if (error instanceof ApiError) {
    const reason =
      typeof error.details === "object" && error.details !== null && "reason" in error.details
        ? String((error.details as { reason: unknown }).reason)
        : null;
    const title =
      reason === "unknown_client"
        ? "This request names no registered client"
        : reason === "redirect_uri_unregistered" || reason === "redirect_uri_missing"
          ? "This request cannot be sent back safely"
          : error.status === 401
            ? "Sign in to continue"
            : "This request cannot be completed";
    return { title, message: error.message };
  }
  return { title: "This request cannot be completed", message: "Could not reach the server." };
}

function ConsentRoute() {
  const params = Route.useSearch();
  const request = useQuery(consentRequestQuery(params));
  const connections = useQuery(connectionsQuery);
  const agents = useQuery(agentsQuery);

  useScreenTitle(request.data ? `Connect ${request.data.client.name}` : "Connect");

  let content: React.ReactNode;
  if (request.isPending) {
    content = <Loader />;
  } else if (request.isError || !request.data) {
    const { title, message } = refusalOf(request.error);
    content = (
      <Empty className="mx-auto h-full max-w-md px-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <DangerousIcon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>
            {message.replace(/\.$/, "")} — nothing has been connected. Start again from the app that
            asked.
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" nativeButton={false} render={<Link to="/agents" />}>
          See your agents
        </Button>
      </Empty>
    );
  } else {
    content = (
      <ConsentCard
        request={request.data}
        params={params}
        connections={connections.data?.connections}
        connectionsFailed={
          connections.isError
            ? {
                error: connections.error,
                onRetry: () => void connections.refetch(),
                retrying: connections.isFetching,
              }
            : undefined
        }
        agents={agents.data?.agents}
        agentsFailed={
          agents.isError
            ? {
                error: agents.error,
                onRetry: () => void agents.refetch(),
                retrying: agents.isFetching,
              }
            : undefined
        }
      />
    );
  }

  return <PageContainer size="medium">{content}</PageContainer>;
}
