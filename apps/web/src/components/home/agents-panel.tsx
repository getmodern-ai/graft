import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { ConnectAgent } from "@/components/home/get-started-panel";
import {
  HomeListFailed,
  HomeListLoading,
  HomePanel,
  HomeRow,
  HomeRowText,
} from "@/components/home/home-panel";
import { AddIcon } from "@/components/icons";
import { HarnessMark } from "@/components/marks";
import { RequestList, RequestListNote } from "@/components/pending/request-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  agentClientLine,
  agentMark,
  connectAgentTarget,
  requestCounts,
  requestsLabel,
} from "@/lib/agent-cards";
import { type AgentListItem, agentsQuery } from "@/lib/agent-queries";
import { homeAgents } from "@/lib/home";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { type SetupStateData, setupQuery } from "@/lib/setup-queries";

/**
 * *Your agents* (GRA-327): each active agent's mark, name and client line (GRA-324's decisions in
 * `lib/agent-cards.ts`), with its open requests as a chip, or *Connect its agent* while it awaits
 * its software (ADR 0024); then *Connect another agent*. Both open Home's own dialogs
 * (`HomeConnectAgentDialog`, `HomeCreateAgentDialog`; GRA-328, GRA-347): what each does can swap
 * this panel's rows or Home's view, and the token each shows once must not go with them.
 */
export function AgentsPanel({
  onConnectAgent,
  onCreateAgent,
}: {
  onConnectAgent: ConnectAgent;
  onCreateAgent: () => void;
}) {
  const agents = useQuery(agentsQuery);
  // The sidebar's read and key, so a chip's count is a share of the badge's.
  const pending = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const setup = useQuery(setupQuery);
  const { shown } = homeAgents(agents.data?.agents ?? []);
  const requests = requestCounts(pending.data?.pendingActions ?? []);

  return (
    <HomePanel
      title="Your agents"
      description="The agents you've connected to Graft."
      more={{ label: "All agents", render: <Link to="/agents" /> }}
    >
      <RequestList aria-label="Your agents" aria-busy={agents.isPending}>
        {agents.isPending ? (
          <HomeListLoading />
        ) : agents.isError && !agents.data ? (
          <HomeListFailed query={agents} message="Could not load your agents." />
        ) : shown.length === 0 ? (
          <RequestListNote>No agents yet.</RequestListNote>
        ) : (
          shown.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              requests={requests.get(agent.id) ?? 0}
              setup={setup.data}
              onConnectAgent={onConnectAgent}
            />
          ))
        )}
        <HomeRow>
          <AddIcon className="size-5 shrink-0 text-muted-foreground" />
          <HomeRowText
            title={
              <button
                type="button"
                className="rounded-sm text-left underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={onCreateAgent}
              >
                Connect another agent
              </button>
            }
            detail="Works with Claude, ChatGPT, Hermes, OpenClaw and more"
          />
        </HomeRow>
      </RequestList>
    </HomePanel>
  );
}

function AgentRow({
  agent,
  requests,
  setup,
  onConnectAgent,
}: {
  agent: AgentListItem;
  requests: number;
  setup: SetupStateData | undefined;
  onConnectAgent: ConnectAgent;
}) {
  const target = connectAgentTarget(agent, setup);
  return (
    <HomeRow>
      <HarnessMark mark={agentMark(agent, setup)} tile="none" className="size-5" />
      <HomeRowText
        title={
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {agent.name}
          </Link>
        }
        detail={agentClientLine(agent)}
      />
      {target === "setup" ? (
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/setup" search={{ agent: agent.id }} />}
        >
          Connect its agent
        </Button>
      ) : target === "dialog" ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Connect ${agent.name}`}
          onClick={(event) => onConnectAgent(agent, event.currentTarget)}
        >
          Connect its agent
        </Button>
      ) : requests > 0 ? (
        <Badge render={<Link to="/pending" />}>{requestsLabel(requests)}</Badge>
      ) : null}
    </HomeRow>
  );
}
