import { isStarterVendorId } from "@graft/core/setup/starter-vendors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import { RetryNotice } from "@/components/retry-notice";
import { SetupChoice, type SetupChoiceOption } from "@/components/setup/setup-choice";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pendingKeys } from "@/lib/pending-action-queries";
import { connectSetup, setupVendorsQuery } from "@/lib/setup-queries";
import { ANOTHER_VENDOR, SETUP_CONNECT_LABEL } from "@/lib/setup-vendors";

/**
 * The starter vendors this deployment can connect, as the server lists them (GRA-206; ADR 0024),
 * one sentence each saying what the first tool will show, and *Another vendor* last. Continue on a
 * starter opens the agent's own connection ask (`POST /api/setup/connect`), which the connect step
 * then draws; on *Another vendor* it opens the ordinary Add connection form, and the connection it
 * makes is taken on by the record. That connection's id is kept, so a handoff that fails after the
 * form closed is tried again with it, rather than opening a blank form for a second connection.
 *
 * Drawn by the vendor step, and by the connect step when the person chooses another vendor there,
 * so both offer the same list the same way.
 */
export function VendorChoice({ onChosen }: { onChosen?: () => void }) {
  const vendors = useQuery(setupVendorsQuery);
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // The connection *Another vendor*'s form made, until the record has taken it on.
  const [madeConnectionId, setMadeConnectionId] = useState<string | null>(null);
  const connect = useSetupMutation(connectSetup);
  const handOff = (connectionId: string) => connect.mutate({ connectionId }, chosen);

  const chosen = {
    onSuccess: () => {
      setMadeConnectionId(null);
      // The ask the connect step draws is in the inbox's list from now on.
      void queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      onChosen?.();
    },
  };

  if (vendors.isPending) {
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

  return (
    <>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!choice) return;
          if (choice === ANOTHER_VENDOR) {
            if (madeConnectionId) handOff(madeConnectionId);
            else setFormOpen(true);
          } else if (isStarterVendorId(choice)) connect.mutate({ starterId: choice }, chosen);
        }}
      >
        <SetupChoice
          name="setup-vendor"
          legend="Vendor"
          options={options}
          value={choice}
          onChange={setChoice}
          disabled={connect.isPending}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={!choice || connect.isPending}>
            {connect.isPending ? "Connecting…" : "Continue"}
          </Button>
        </div>
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
