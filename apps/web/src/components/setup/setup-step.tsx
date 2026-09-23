import type { SetupStep } from "@graft/core/setup/setup.rules";
import { Link } from "@tanstack/react-router";
import type * as React from "react";

import { CheckCircleIcon } from "@/components/icons";
import { BuildingStep } from "@/components/setup/building-step";
import { ConnectStep } from "@/components/setup/connect-step";
import { GoalStep } from "@/components/setup/goal-step";
import { HarnessStep } from "@/components/setup/harness-step";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { VendorStep } from "@/components/setup/vendor-step";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DEFAULT_SIGNED_IN_PATH } from "@/lib/safe-redirect";
import type { SetupStateData } from "@/lib/setup-queries";

/**
 * The step the person is on, by `state.step` (`currentSetupStep` in `@graft/core`, answered by the
 * server): **one component per step**, one file each under `components/setup/`, and this map is
 * the one place a step is wired in, as `pending-action-card.tsx` dispatches an ask by its kind. A
 * later ticket adds a step by writing its file and replacing its entry here; every step takes the
 * whole state and moves the record on through `useSetupMutation`.
 */
const STEPS: Record<SetupStep, (props: { state: SetupStateData }) => React.ReactNode> = {
  harness: HarnessStep,
  vendor: VendorStep,
  connect: ConnectStep,
  goal: GoalStep,
  building: BuildingStep,
  // GRA-208: the result and the finish, which a pass and Continue while it builds reach.
  result: StepNotReady,
  finish: StepNotReady,
  completed: SetupCompleted,
};

export function SetupStepView({ state }: { state: SetupStateData }) {
  const Step = STEPS[state.step];
  return <Step state={state} />;
}

function StepNotReady() {
  return (
    <SetupStepHeader
      title="This step is not available yet"
      description="Skip Setup for now; your agent and anything Setup made stay as they are."
    />
  );
}

function SetupCompleted() {
  return (
    <Empty className="mx-auto max-w-md">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCircleIcon />
        </EmptyMedia>
        <EmptyTitle>Setup is complete</EmptyTitle>
        <EmptyDescription>
          Your agent, its connection and its first tool are ready.
        </EmptyDescription>
      </EmptyHeader>
      <Button nativeButton={false} render={<Link to={DEFAULT_SIGNED_IN_PATH} />}>
        Open the console
      </Button>
    </Empty>
  );
}
