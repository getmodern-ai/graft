import { isStarterVendorId } from "@graft/core/setup/starter-vendors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import { AddIcon, InfoIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { DiscardJobDialog } from "@/components/setup/discard-job-dialog";
import { SetupChoice, type SetupChoiceOption } from "@/components/setup/setup-choice";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupLogo } from "@/components/setup/setup-logo";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pendingKeys } from "@/lib/pending-action-queries";
import {
  chooseSetupStarter,
  connectSetup,
  type SetupStateData,
  setupGoalQuery,
  setupVendorsQuery,
} from "@/lib/setup-queries";
import { ANOTHER_VENDOR, choiceLeavesJob, SETUP_CONNECT_LABEL } from "@/lib/setup-vendors";

/**
 * The starter integrations this deployment connects in one click, as the server lists them
 * (GRA-206, GRA-216; ADR 0024), one sentence each saying what the first tool will show, and
 * *Another integration* last. Continue on a starter opens the agent's own connection ask
 * (`POST /api/setup/connect`), which the connect step then draws; on *Another integration* it opens the ordinary Add connection form, and the connection it
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
  const heldStarter = state.setup?.starterId ?? (holds ? (goal.data?.starterId ?? null) : null);
  const [picked, setPicked] = useState<string | null>(null);
  const choice = picked ?? heldStarter;
  const [formOpen, setFormOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The connection *Another integration*'s form made, until the record has taken it on.
  const [madeConnectionId, setMadeConnectionId] = useState<string | null>(null);
  // The person agreed to leave the running job behind, for the form's handoff too.
  const [discard, setDiscard] = useState(false);
  const connect = useSetupMutation(connectSetup);
  // Setup v2: a starter is chosen before anything is connected, and the tool screen follows.
  const choose = useSetupMutation(chooseSetupStarter);
  const busy = connect.isPending || choose.isPending;
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
      choose.mutate({ starterId: choice });
    }
  };

  if (vendors.isPending || (holds && goal.isPending)) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-36 rounded-lg" />
        ))}
      </div>
    );
  }
  if (vendors.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        <RetryNotice
          error={vendors.error}
          message="Could not load the integrations."
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
      media: <SetupLogo starterId={option.starter.id} />,
    })),
    {
      value: ANOTHER_VENDOR,
      label: "Another integration",
      description: "Any service with an API: its address, how it signs in and its key.",
      media: (
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background"
        >
          <AddIcon className="size-5" />
        </span>
      ),
      aside: <Badge variant="outline">Any API</Badge>,
      dashed: true,
    },
  ];
  const held = goal.data
    ? { starterId: goal.data.starterId, jobStatus: goal.data.job?.status ?? null }
    : null;
  const picked_ = vendors.data.vendors.find((option) => option.starter.id === choice);

  return (
    <>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!choice) return;
          if (choice === ANOTHER_VENDOR && choiceLeavesJob(choice, held)) setConfirming(true);
          else go(false);
        }}
      >
        <SetupChoice
          name="setup-vendor"
          legend="Integration"
          layout="stack"
          options={options}
          value={choice}
          onChange={setPicked}
          disabled={busy}
        />
        <SetupFooter
          state={state}
          disabled={busy}
          summary={
            picked_ ? (
              <>
                <SetupLogo starterId={picked_.starter.id} tile={false} className="size-5" />
                <span className="font-medium text-foreground">{picked_.starter.displayName}</span>
                <span>· {SETUP_CONNECT_LABEL[picked_.connect]}</span>
              </>
            ) : choice === ANOTHER_VENDOR ? (
              <>
                <AddIcon className="size-4 shrink-0" />
                <span className="font-medium text-foreground">Another integration</span>
                <span>· You enter its key next</span>
              </>
            ) : (
              <>
                <InfoIcon className="size-4 shrink-0" />
                Pick one integration to start with
              </>
            )
          }
        >
          <Button type="submit" disabled={!choice || busy}>
            {busy ? "Continuing…" : "Continue"}
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
