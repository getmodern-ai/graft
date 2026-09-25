import { readAuthorizationRequestParams } from "@graft/core/mcp-oauth/mcp-oauth.rules";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type * as React from "react";

import { ConsentCard } from "@/components/agent/consent-card";
import { AuthHeader } from "@/components/auth/auth-header";
import { DangerousIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
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
 * signed-out person signs in and comes straight back (ADR 0006), which is how a chat product's
 * "connect" reaches a person with no session yet.
 *
 * **A focused page, not the console** (GRA-219), drawn as the handoff page is (`pending.$id.tsx`,
 * GRA-144): the person arrived from a chat or a terminal and is on their way back to it, so the
 * page is the mark and one card, with the console one link away and no sidebar to leave through.
 * Outside the shell, Setup's intercept never reaches it; `setup-intercept.ts` still exempts the
 * path for a visit that goes through the shell first.
 *
 * The server describes the request first: a client or a redirect URI it cannot vouch for is a
 * refusal page with nothing to press, in the shape the handoff refusal takes (`pending.$id.tsx`),
 * and the browser is never sent anywhere. A sound request is the card.
 */
export const Route = createFileRoute("/_auth/consent")({
  validateSearch: (search: Record<string, unknown>) => readAuthorizationRequestParams(search),
  head: () => ({
    meta: [{ title: "Graft: Connect" }, { name: "robots", content: "noindex" }],
  }),
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
            {message.replace(/\.$/, "")}. Nothing has been connected. Start again from the app that
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

  return (
    <main className="flex min-h-svh flex-col">
      <AuthHeader />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
        {content}
        {request.data ? (
          <p className="text-center text-muted-foreground text-sm">
            From a desktop app, this may end on a page saying you can close the window. Close it and
            go back to {request.data.client.name}.
          </p>
        ) : null}
        <p className="text-center text-muted-foreground text-sm">
          <Link to="/agents" className="underline underline-offset-4">
            Your agents, in the console
          </Link>
        </p>
      </div>
    </main>
  );
}
