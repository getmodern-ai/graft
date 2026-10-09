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
 * **One footer on every step** (GRA-215), drawn as Setup v2's sticky bar (the Figma frames'
 * `StickyFooter`): pinned to the bottom of the viewport across the page's width above a border,
 * with the step's summary on the left (what is chosen, or what happens next) and its actions on the
 * right, *Back* first as an outline button and the primary last. `children` is the right-hand
 * side. `onBack` replaces the record's back move where the step's own Back is something else (the
 * tool screen's Back clears the starter rather than moving the record); `back={false}` hides it.
 */
export function SetupFooter({
  state,
  children,
  disabled,
  summary,
  onBack,
  back: showBack = true,
}: {
  state: SetupStateData;
  children?: React.ReactNode;
  /** Back is held while the step's own action runs, so the two never race. */
  disabled?: boolean;
  summary?: React.ReactNode;
  onBack?: { run: () => void; pending: boolean };
  back?: boolean;
}) {
  const back = useSetupBack();
  const target = backTargetOf(state);
  const backButton = !showBack ? null : onBack ? (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || onBack.pending}
      onClick={onBack.run}
    >
      <ArrowBackIcon />
      {onBack.pending ? "Going back…" : "Back"}
    </Button>
  ) : target ? (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || back.isPending}
      onClick={() => back.mutate(target)}
    >
      <ArrowBackIcon />
      {back.isPending ? "Going back…" : "Back"}
    </Button>
  ) : null;
  return (
    <>
      {/* Holds the bar's height at the end of the step, so nothing scrolls under it for good. */}
      <div aria-hidden="true" className="h-20 shrink-0" />
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background">
        <div className="flex min-h-20 flex-wrap items-center justify-between gap-3 px-4 py-4 md:px-8">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm">
            {summary}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {backButton}
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
