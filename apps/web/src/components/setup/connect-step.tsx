import { useQuery, useQueryClient } from "@tanstack/react-query";

import { CheckCircleIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import {
  nextSetup,
  type SetupStateData,
  setupGoalQuery,
  setupKeys,
  setupQuery,
} from "@/lib/setup-queries";
import { connectAskView } from "@/lib/setup-vendors";

/** How often the step re-reads the state while the ask is open, for an answer given elsewhere. */
const CONNECT_POLL_MS = 3_000;

/**
 * The connect step (GRA-206; GRA-202, *The connect step is the agent's own connection ask*): the
 * ask the vendor step opened, drawn with the pending-action card for its kind: the provider's
 * link, the keyless confirmation, or the secret form pre-filled with the host and the scheme, with
 * the build choice pre-ticked as on every connection ask. The card is told `origin="setup"`, so it
 * drops the model's provenance (Graft wrote the proposal from the starter entry) and folds the
 * proposal editor behind *Edit the connection*; the secret inputs stay open. It is an ask like any
 * other, so it is in the inbox too, and an answer given there or in a chat's card counts the same:
 * the step re-reads the state while the ask is open, and the server moves the record to the goal
 * step on the read after the answer (`GET /api/setup`). A decline or an expiry takes it back to
 * the vendor step.
 *
 * **One footer** (GRA-215): Back to the integration list is how another one is chosen, the old
 * *Choose another vendor* button's job; the ask left open stays in the inbox until it expires.
 * While the ask is open its card's own Connect is the step's primary action, since the card holds
 * the form it answers with. Returned to after the connection was made, the step shows that
 * connection and Continue walks on with it (`POST /api/setup/next`).
 */
export function ConnectStep({ state }: { state: SetupStateData }) {
  const askId = state.setup?.pendingActionId ?? null;
  if (!askId && state.setup?.connectionId) return <ConnectionMade state={state} />;
  return <OpenAsk state={state} askId={askId} />;
}

function OpenAsk({ state, askId }: { state: SetupStateData; askId: string | null }) {
  const queryClient = useQueryClient();
  // The same entry the page reads, polled while this step is on screen.
  useQuery({ ...setupQuery, refetchInterval: CONNECT_POLL_MS });
  const openAsks = useQuery({ ...pendingActionsQuery, refetchInterval: CONNECT_POLL_MS });
  const view = connectAskView(askId, openAsks.data?.pendingActions);
  const vendorName =
    view.kind === "card" && typeof view.action.payload.displayName === "string"
      ? view.action.payload.displayName
      : "the vendor";

  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title={`Connect ${vendorName}`}
        description={`${state.agent?.name ?? "Your agent"} asks for this connection as its own, the way it would from your harness. Answer it here.`}
      />
      {view.kind === "card" ? (
        <PendingActionCard
          // Keyed by the ask: another tab choosing another starter replaces the ask under this card,
          // and a card's draft is made once, so a new ask gets a fresh card rather than the old one's.
          key={view.action.id}
          action={view.action}
          origin="setup"
          onAnswered={() => void queryClient.invalidateQueries({ queryKey: setupKeys.current })}
        />
      ) : (
        <Loader />
      )}
      <SetupFooter state={state} />
    </div>
  );
}

function ConnectionMade({ state }: { state: SetupStateData }) {
  const goal = useQuery(setupGoalQuery);
  const next = useSetupMutation(nextSetup);
  const connection = goal.data?.connection;
  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title={connection ? `${connection.displayName} is connected` : "Connected"}
        description={`${state.agent?.name ?? "Your agent"} has this connection in its scope. Go back to choose another integration.`}
      />
      {goal.isPending ? (
        <Loader />
      ) : connection ? (
        <Item variant="outline">
          <ItemMedia variant="icon">
            <CheckCircleIcon />
          </ItemMedia>
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
      <SetupFooter state={state} disabled={next.isPending}>
        <Button disabled={next.isPending} onClick={() => next.mutate({ from: "connect" })}>
          {next.isPending ? "Continuing…" : "Continue"}
        </Button>
      </SetupFooter>
    </div>
  );
}
