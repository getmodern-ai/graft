import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { HomePanel } from "@/components/home/home-panel";
import {
  RequestList,
  RequestListLoading,
  RequestListNote,
  RequestRow,
} from "@/components/pending/request-row";
import { RetryNotice } from "@/components/retry-notice";
import { agentsQuery } from "@/lib/agent-queries";
import { firstOf, NEEDS_YOU_ROWS } from "@/lib/home";
import { harnessMark } from "@/lib/marks";
import { pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * *Needs you* (GRA-327): the first open requests as the Requests screen draws them (`RequestRow`,
 * GRA-310, with GRA-311's Allow menu and dialog), then "See all requests". The count is the
 * sidebar's: the same read under the same key and poll, so the two never disagree.
 *
 * Sign-in rows (a connection that needs the person, GRA-313) belong in this list beside the asks
 * once `SignInRequestRow` lands, counted with them as the sidebar will count them; until then the
 * panel lists the asks alone.
 */
export function NeedsYouPanel() {
  const requests = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const agents = useQuery(agentsQuery);
  const all = requests.data?.pendingActions ?? [];
  const { shown } = firstOf(all, NEEDS_YOU_ROWS);
  const harnessOf = new Map(
    (agents.data?.agents ?? []).map((agent) => [
      agent.id,
      harnessMark(agent.connectedVia?.clientName),
    ]),
  );

  return (
    <HomePanel
      title="Needs you"
      count={all.length}
      description="Answer what your agents are waiting on."
      more={{ label: "See all requests", render: <Link to="/pending" /> }}
    >
      <RequestList aria-label="Open requests" aria-busy={requests.isPending}>
        {requests.isPending ? (
          <RequestListLoading rows={2} />
        ) : requests.isError && !requests.data ? (
          <RequestListNote>
            <RetryNotice
              error={requests.error}
              message="Your requests could not be loaded."
              onRetry={() => void requests.refetch()}
              retrying={requests.isFetching}
            />
          </RequestListNote>
        ) : shown.length === 0 ? (
          <RequestListNote>Nothing is waiting on you.</RequestListNote>
        ) : (
          shown.map((action) => (
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
