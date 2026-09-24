import { useQuery } from "@tanstack/react-query";

import { InfoIcon } from "@/components/icons";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { connectionsQuery } from "@/lib/connection-queries";
import type { SetupStateData } from "@/lib/setup-queries";

/**
 * The goal step, a placeholder until GRA-207 puts the goal, its suggestions and Build here: it
 * names the connection the record learned, so the move from the connect step is visible and a
 * reload resumes on it. GRA-207 replaces the body; the starter's curated goal is
 * `starterVendorFor(connection.vendor)` in `@graft/core`.
 */
export function GoalStep({ state }: { state: SetupStateData }) {
  const connections = useQuery(connectionsQuery);
  const connection = connections.data?.connections.find(
    (candidate) => candidate.id === state.setup?.connectionId,
  );
  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title="Choose a goal"
        description="Say what the first tool should read, and Graft builds it."
      />
      {connection ? (
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>
              {connection.displayName}
              <Badge variant="outline">{connection.vendor}</Badge>
            </ItemTitle>
            <ItemDescription>
              Connected, and in {state.agent?.name ?? "the agent"}'s scope.
            </ItemDescription>
          </ItemContent>
        </Item>
      ) : null}
      <Alert>
        <InfoIcon />
        <AlertTitle>Building a first tool is on its way</AlertTitle>
        <AlertDescription>
          This step will suggest a goal and build the tool. Until then, skip Setup for now; your
          agent and its connection stay as they are.
        </AlertDescription>
      </Alert>
    </div>
  );
}
