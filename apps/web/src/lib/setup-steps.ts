import { SETUP_STEPS, type SetupStep } from "@graft/core/setup/setup.rules";

/**
 * Setup's steps as the console names them (ADR 0024): the rail on the left at `md` and up, and the
 * progress line above the step below it. The order is `@graft/core`'s (`SETUP_STEPS`), which the
 * record's column holds; the labels are the console's, sentence case like every label in it. The
 * record's `building` is the rail's *Build*, and `completed` is the state after the last step,
 * never a step of its own on the rail.
 */

export type SetupRailStep = Exclude<SetupStep, "completed">;

export const SETUP_STEP_LABEL: Record<SetupRailStep, string> = {
  harness: "Harness",
  vendor: "Vendor",
  connect: "Connect",
  goal: "Goal",
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
};

/** Every rail step with where it stands against the current one; all done once completed. */
export function setupRail(current: SetupStep): SetupRailEntry[] {
  const at = current === "completed" ? SETUP_RAIL_STEPS.length : SETUP_RAIL_STEPS.indexOf(current);
  return SETUP_RAIL_STEPS.map((step, index) => ({
    step,
    label: SETUP_STEP_LABEL[step],
    position: index + 1,
    state: index < at ? "done" : index === at ? "current" : "upcoming",
  }));
}

/**
 * The line below `md`, where the rail collapses: "Step 2 of 7: Vendor", or "Setup complete". The
 * fraction is the bar's width beside it.
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
