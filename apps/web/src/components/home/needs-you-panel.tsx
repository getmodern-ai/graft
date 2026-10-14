import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { HomePanel } from "@/components/home/home-panel";
import {
  RequestList,
  RequestListLoading,
  RequestListNote,
  RequestRow,
} from "@/components/pending/request-row";
import { SignInRequestRow } from "@/components/pending/sign-in-request-row";
import { RetryNotice } from "@/components/retry-notice";
import { agentsQuery } from "@/lib/agent-queries";
import { needsYouRows } from "@/lib/home";
import { integrationsQuery } from "@/lib/integration-queries";
import { harnessMark } from "@/lib/marks";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { openRequestCount, signInRequestsOf } from "@/lib/sign-in-requests";

/**
 * *Needs you* (GRA-327): the first rows of Requests' Open list as that screen draws them, the
 * sign-in rows (`SignInRequestRow`, GRA-313) then the asks (`RequestRow`, GRA-310, with GRA-311's
 * Allow menu and dialog), and "See all requests". The count is the sidebar's: the same two reads
 * under the same keys and poll, through `openRequestCount`, so the two never disagree. The sign-in
 * rows draw whatever the asks' read is doing, as on Requests.
 */
export function NeedsYouPanel() {
  const requests = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const integrations = useQuery({ ...integrationsQuery, refetchInterval: 15_000 });
  const agents = useQuery(agentsQuery);
  const asks = requests.data?.pendingActions ?? [];
  const signIns = signInRequestsOf(integrations.data?.integrations ?? []);
  const shown = needsYouRows(signIns, asks);
  const harnessOf = new Map(
    (agents.data?.agents ?? []).map((agent) => [
      agent.id,
      harnessMark(agent.connectedVia?.clientName),
    ]),
  );

  return (
    <HomePanel
      title="Needs you"
      count={openRequestCount(asks.length, integrations.data?.integrations)}
      description="Answer what your agents are waiting on."
      more={{ label: "See all requests", render: <Link to="/pending" /> }}
    >
      <RequestList aria-label="Open requests" aria-busy={requests.isPending}>
        {shown.signIns.map((request) => (
          <SignInRequestRow key={request.key} request={request} />
        ))}
        {requests.isPending ? (
          <RequestListLoading rows={signIns.length > 0 ? 1 : 2} />
        ) : requests.isError && !requests.data ? (
          <RequestListNote>
            <RetryNotice
              error={requests.error}
              message="Your requests could not be loaded."
              onRetry={() => void requests.refetch()}
              retrying={requests.isFetching}
            />
          </RequestListNote>
        ) : asks.length + signIns.length === 0 ? (
          <RequestListNote>Nothing is waiting on you.</RequestListNote>
        ) : (
          shown.asks.map((action) => (
            <RequestRow
              key={action.id}
              action={action}
              harness={harnessOf.get(action.agentId) ?? "generic"}
            />
          ))
        )}
      </RequestList>
    </HomePanel>
  );
}
