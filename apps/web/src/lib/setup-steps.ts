import {
  previousSetupStep,
  SETUP_STEPS,
  type SetupNavigationFields,
  type SetupStep,
  setupBackTargets,
} from "@graft/core/setup/setup.rules";

/**
 * Setup's steps as the console names them (ADR 0024): the rail on the left at `md` and up, and the
 * progress line above the step below it. The order is `@graft/core`'s (`SETUP_STEPS`), which the
 * record's column holds; the labels are the console's, sentence case like every label in it. The
 * record's `vendor` is the rail's *Integration* and its `goal` the rail's *Task* (the person's
 * words since GRA-215, ahead of GRA-216's rename of the steps themselves), its `building` is
 * *Build*, and `completed` is the state after the last step, never a step of its own on the rail.
 */

export type SetupRailStep = Exclude<SetupStep, "completed">;

export const SETUP_STEP_LABEL: Record<SetupRailStep, string> = {
  harness: "Harness",
  vendor: "Integration",
  connect: "Connect",
  goal: "Task",
  building: "Build",
  result: "Result",
  finish: "Finish",
};

export const SETUP_RAIL_STEPS: readonly SetupRailStep[] = SETUP_STEPS.filter(
  (step): step is SetupRailStep => step !== "completed",
);

export type SetupRailState = "done" | "current" | "upcoming";

export type SetupRailEntry = {
  step: SetupRailStep;
  label: string;
  /** One-based, as the rail numbers it. */
  position: number;
  state: SetupRailState;
  /**
   * Whether the entry is a link (GRA-215): a step the record can go back to, and the current one,
   * which goes nowhere. A step ahead of the record never is, and nothing is once Setup is complete.
   */
  link: boolean;
};

/**
 * Every rail step with where it stands against the current one (GRA-215, *The rail is
 * navigable*). With the record, a step before the current one is done, and a link, when the record
 * holds what it shows (`setupBackTargets`, the rule the server's back move admits by), so the
 * result a record passed while its job ran is neither. Without it, or when the record's own step is
 * not the one on screen (the harness step drawn for an agent revoked since), the steps before are
 * done and nothing is a link. All done, and none a link, once completed.
 */
export function setupRail(
  current: SetupStep,
  record?: SetupNavigationFields | null,
): SetupRailEntry[] {
  const at = current === "completed" ? SETUP_RAIL_STEPS.length : SETUP_RAIL_STEPS.indexOf(current);
  const navigable = record && record.step === current ? setupBackTargets(record) : null;
  return SETUP_RAIL_STEPS.map((step, index) => {
    const before = index < at;
    const back = navigable?.includes(step) ?? false;
    const state: SetupRailState =
      index === at ? "current" : before && (navigable === null || back) ? "done" : "upcoming";
    return {
      step,
      label: SETUP_STEP_LABEL[step],
      position: index + 1,
      state,
      link: back || (index === at && navigable !== null),
    };
  });
}

/**
 * The line below `md`, where the rail collapses: "Step 2 of 7: Integration", or "Setup complete".
 * The fraction is the bar's width beside it.
 */
export function setupProgress(current: SetupStep): { text: string; fraction: number } {
  const total = SETUP_RAIL_STEPS.length;
  if (current === "completed") return { text: "Setup complete", fraction: 1 };
  const position = SETUP_RAIL_STEPS.indexOf(current) + 1;
  return {
    text: `Step ${position} of ${total}: ${SETUP_STEP_LABEL[current]}`,
    fraction: position / total,
  };
}

/** A step the back move can name (`POST /api/setup/back`): never the finish or the state after it. */
export type SetupBackStep = Exclude<SetupStep, "finish" | "completed">;

function isBackStep(step: SetupStep | null): step is SetupBackStep {
  return step !== null && step !== "finish" && step !== "completed";
}

/**
 * The step the footer's *Back* returns to (GRA-215): the record's previous step that it holds what
 * for (`previousSetupStep`), only while the record's own step is the one on screen, and none on the
 * first step. The same rule the rail's links follow, so Back and the link before the current step
 * are one move.
 */
export function backTargetOf(state: {
  step: SetupStep;
  setup: SetupNavigationFields | null;
}): SetupBackStep | null {
  const record = state.setup;
  if (!record || record.step !== state.step) return null;
  const previous = previousSetupStep(record);
  return isBackStep(previous) ? previous : null;
}

/** A rail entry's step as the back move names it, or null for one it cannot (the current finish). */
export function backStepOf(step: SetupRailStep): SetupBackStep | null {
  return isBackStep(step) ? step : null;
}
