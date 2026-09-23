import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Loader } from "@/components/loader";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { VendorChoice } from "@/components/setup/vendor-choice";
import { Button } from "@/components/ui/button";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { type SetupStateData, setupKeys, setupQuery } from "@/lib/setup-queries";
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
 * the vendor step. *Choose another vendor* offers the list again here.
 */
export function ConnectStep({ state }: { state: SetupStateData }) {
  const queryClient = useQueryClient();
  const [choosing, setChoosing] = useState(false);
  // The same entry the page reads, polled while this step is on screen.
  useQuery({ ...setupQuery, refetchInterval: CONNECT_POLL_MS });
  const openAsks = useQuery({ ...pendingActionsQuery, refetchInterval: CONNECT_POLL_MS });
  const view = connectAskView(state.setup?.pendingActionId ?? null, openAsks.data?.pendingActions);
  const vendorName =
    view.kind === "card" && typeof view.action.payload.displayName === "string"
      ? view.action.payload.displayName
      : "the vendor";

  if (choosing) {
    return (
      <div className="flex flex-col gap-6">
        <SetupStepHeader
          title="Choose another vendor"
          description="The ask you leave stays in your inbox until it expires, and you can decline it there."
        />
        <VendorChoice onChosen={() => setChoosing(false)} />
        <div>
          <Button variant="ghost" onClick={() => setChoosing(false)}>
            Back to {vendorName}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title={`Connect ${vendorName}`}
        description={`${state.agent?.name ?? "Your agent"} asks for this connection as its own, the way it would from your harness. Answer it here.`}
      />
      {view.kind === "card" ? (
        <PendingActionCard
          action={view.action}
          origin="setup"
          onAnswered={() => void queryClient.invalidateQueries({ queryKey: setupKeys.current })}
        />
      ) : (
        <Loader />
      )}
      <div>
        <Button variant="ghost" onClick={() => setChoosing(true)}>
          Choose another vendor
        </Button>
      </div>
    </div>
  );
}
