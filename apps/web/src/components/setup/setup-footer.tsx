import type * as React from "react";

import { ArrowBackIcon } from "@/components/icons";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Button } from "@/components/ui/button";
import { backSetup, type SetupStateData } from "@/lib/setup-queries";
import { backTargetOf, type SetupBackStep } from "@/lib/setup-steps";

/**
 * The move back to a step, shared by the rail and the footer (GRA-215): one mutation over
 * `POST /api/setup/back`, whose answer is the state as every Setup verb's is.
 */
export function useSetupBack() {
  return useSetupMutation((step: SetupBackStep) => backSetup({ step }));
}

/**
 * **One footer on every step** (GRA-215): *Back* at the bottom left, the same move as the rail's
 * link to the step before, and the step's primary action at the bottom right. Composed for Setup
 * (ADR 0017's delta): Cando's dialog footer puts its actions at the end; a wizard needs the way
 * back at the start, so this is the same row with the ghost Back button first and the actions
 * pushed to the end, the rhythm the steps already had. The first step has no Back. `children` is
 * the right-hand side: the primary Button last, a secondary outline one before it.
 */
export function SetupFooter({
  state,
  children,
  disabled,
}: {
  state: SetupStateData;
  children?: React.ReactNode;
  /** Back is held while the step's own action runs, so the two never race. */
  disabled?: boolean;
}) {
  const back = useSetupBack();
  const target = backTargetOf(state);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
      {target ? (
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || back.isPending}
          onClick={() => back.mutate(target)}
        >
          <ArrowBackIcon />
          {back.isPending ? "Going back…" : "Back"}
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}
