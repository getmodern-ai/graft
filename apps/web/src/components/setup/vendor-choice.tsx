import { isStarterVendorId } from "@graft/core/setup/starter-vendors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import { RetryNotice } from "@/components/retry-notice";
import { DiscardJobDialog } from "@/components/setup/discard-job-dialog";
import { SetupChoice, type SetupChoiceOption } from "@/components/setup/setup-choice";
import { SetupFooter } from "@/components/setup/setup-footer";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pendingKeys } from "@/lib/pending-action-queries";
import {
  connectSetup,
  type SetupStateData,
  setupGoalQuery,
  setupVendorsQuery,
} from "@/lib/setup-queries";
import { ANOTHER_VENDOR, choiceLeavesJob, SETUP_CONNECT_LABEL } from "@/lib/setup-vendors";

/**
 * The starter vendors this deployment can connect, as the server lists them (GRA-206; ADR 0024),
 * one sentence each saying what the first tool will show, and *Another vendor* last. Continue on a
 * starter opens the agent's own connection ask (`POST /api/setup/connect`), which the connect step
 * then draws; on *Another vendor* it opens the ordinary Add connection form, and the connection it
 * makes is taken on by the record. That connection's id is kept, so a handoff that fails after the
 * form closed is tried again with it, rather than opening a blank form for a second connection.
 *
 * **Returned to** (GRA-215): the record still names the connection it made, so the starter it came
 * from is chosen already, and Continue with it keeps the connection and anything built on it.
 * Another choice replaces it; while the job built on it still runs, the step asks first
 * (`DiscardJobDialog`) and sends `discardJob` once the person agrees.
 */
export function VendorChoice({ state }: { state: SetupStateData }) {
  const vendors = useQuery(setupVendorsQuery);
  const holds = state.setup?.connectionId != null;
  // What the record holds from before it came back: the starter and its job's status.
  const goal = useQuery({ ...setupGoalQuery, enabled: holds });
  const queryClient = useQueryClient();
  const heldStarter = holds ? (goal.data?.starterId ?? null) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const choice = picked ?? heldStarter;
  const [formOpen, setFormOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The connection *Another vendor*'s form made, until the record has taken it on.
  const [madeConnectionId, setMadeConnectionId] = useState<string | null>(null);
  // The person agreed to leave the running job behind, for the form's handoff too.
  const [discard, setDiscard] = useState(false);
  const connect = useSetupMutation(connectSetup);
  const handOff = (connectionId: string) =>
    connect.mutate({ connectionId, ...(discard ? { discardJob: true } : {}) }, chosen);

  const chosen = {
    onSuccess: () => {
      setMadeConnectionId(null);
      setConfirming(false);
      // The ask the connect step draws is in the inbox's list from now on.
      void queryClient.invalidateQueries({ queryKey: pendingKeys.all });
    },
  };

  const go = (discardJob: boolean) => {
    if (!choice) return;
    if (choice === ANOTHER_VENDOR) {
      setDiscard(discardJob);
      setConfirming(false);
      if (madeConnectionId) handOff(madeConnectionId);
      else setFormOpen(true);
    } else if (isStarterVendorId(choice)) {
      connect.mutate({ starterId: choice, ...(discardJob ? { discardJob: true } : {}) }, chosen);
    }
  };

  if (vendors.isPending || (holds && goal.isPending)) {
    return (
      <div className="grid gap-2.5 sm:grid-cols-2" aria-busy="true">
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-16 rounded-md" />
        ))}
      </div>
    );
  }
  if (vendors.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        <RetryNotice
          error={vendors.error}
          message="Could not load the vendors."
          onRetry={() => void vendors.refetch()}
          retrying={vendors.isFetching}
        />
      </p>
    );
  }

  const options: SetupChoiceOption<string>[] = [
    ...vendors.data.vendors.map((option) => ({
      value: option.starter.id,
      label: option.starter.displayName,
      description: option.starter.outcome,
      aside: <Badge variant="outline">{SETUP_CONNECT_LABEL[option.connect]}</Badge>,
    })),
    {
      value: ANOTHER_VENDOR,
      label: "Another vendor",
      description: "Connect any vendor with its API address, how it signs in and its key.",
    },
  ];
  const held = goal.data
    ? { starterId: goal.data.starterId, jobStatus: goal.data.job?.status ?? null }
    : null;

  return (
    <>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!choice) return;
          if (choiceLeavesJob(choice, held)) setConfirming(true);
          else go(false);
        }}
      >
        <SetupChoice
          name="setup-vendor"
          legend="Vendor"
          options={options}
          value={choice}
          onChange={setPicked}
          disabled={connect.isPending}
        />
        <SetupFooter state={state} disabled={connect.isPending}>
          <Button type="submit" disabled={!choice || connect.isPending}>
            {connect.isPending ? "Connecting…" : "Continue"}
          </Button>
        </SetupFooter>
      </form>
      {madeConnectionId && connect.isError && choice === ANOTHER_VENDOR ? (
        // Outside the form, so its Retry is never read as the form's submit.
        <p className="text-muted-foreground text-sm">
          <RetryNotice
            error={connect.error}
            message="Your connection was made, but Setup could not take it on."
            onRetry={() => handOff(madeConnectionId)}
            retrying={connect.isPending}
          />
        </p>
      ) : null}
      <DiscardJobDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => go(true)}
        pending={connect.isPending}
        action={{ label: "Choose it anyway", pending: "Connecting…" }}
        consequence="Choosing another integration starts over from its connection."
      />
      {/* Outside the form: a submit inside the dialog's portal would bubble to it through React. */}
      <AddConnectionDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onConnected={(connectionId) => {
          setMadeConnectionId(connectionId);
          handOff(connectionId);
        }}
      />
    </>
  );
}
