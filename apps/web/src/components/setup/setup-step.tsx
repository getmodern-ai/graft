import type { SetupStep } from "@graft/core/setup/setup.rules";
import { Link } from "@tanstack/react-router";
import type * as React from "react";

import { CheckCircleIcon } from "@/components/icons";
import { BuildingStep } from "@/components/setup/building-step";
import { ConnectStep } from "@/components/setup/connect-step";
import { FinishStep, type FinishStepProps } from "@/components/setup/finish-step";
import { GoalStep } from "@/components/setup/goal-step";
import { HarnessStep } from "@/components/setup/harness-step";
import { ResultStep } from "@/components/setup/result-step";
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
import type { SetupFinish, SetupStateData } from "@/lib/setup-queries";

/**
 * The step the person is on, by `state.step` (`currentSetupStep` in `@graft/core`, answered by the
 * server): **one component per step**, one file each under `components/setup/`, and this map is
 * the one place a step is wired in, as `pending-action-card.tsx` dispatches an ask by its kind. A
 * later ticket adds a step by writing its file and replacing its entry here; every step takes the
 * whole state and moves the record on through `useSetupMutation`.
 *
 * The finish is the one step with a second prop: the finish's answer, held by the page, since a
 * token issued there must stay on screen after the record reads `completed` (`finish-step.tsx`).
 * Once the person finished on this page, the finish step stays whatever the state says. The harness
 * step is the other: it takes the agent the page's URL names (`/setup?agent=<id>`, GRA-210), so a
 * Setup opened from `find_tool`'s offer starts as that agent.
 */
const STEPS: Record<
  Exclude<SetupStep, "finish" | "harness">,
  (props: { state: SetupStateData }) => React.ReactNode
> = {
  vendor: VendorStep,
  connect: ConnectStep,
  goal: GoalStep,
  building: BuildingStep,
  result: ResultStep,
  completed: SetupCompleted,
};

export function SetupStepView({
  state,
  finished,
  leaving,
  onFinished,
  issuedToken,
  onTokenIssued,
  agentId,
}: {
  state: SetupStateData;
  finished: SetupFinish | null;
  /** Finish Setup succeeded and the page is leaving for the agent's page (GRA-215). */
  leaving: boolean;
  onFinished: FinishStepProps["onFinished"];
  issuedToken: string | null;
  onTokenIssued: (token: string) => void;
  /** The agent the page's URL names, which the harness step starts as when it is the person's. */
  agentId?: string;
}) {
  if (state.step === "finish" || finished || leaving) {
    return (
      <FinishStep
        state={state}
        finished={finished}
        onFinished={onFinished}
        issuedToken={issuedToken}
        onTokenIssued={onTokenIssued}
      />
    );
  }
  if (state.step === "harness") return <HarnessStep state={state} agentId={agentId} />;
  const Step = STEPS[state.step];
  return <Step state={state} />;
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
