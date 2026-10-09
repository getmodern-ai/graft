import type { SetupStep } from "@graft/core/setup/setup.rules";

/**
 * Setup v2's four stages (the Figma "Console / Setup v2" frames, decided 2026-09-29): the stepper at
 * the top of the page and the eyebrow over each step's title. The record keeps its own seven steps
 * (`SETUP_STEPS`), so this is a reading of them, never a second state:
 *
 * - **Harness**: the harness step.
 * - **Integration**: the vendor step before a starter is chosen.
 * - **Tool**: the vendor step once a starter is chosen (the record's `starterId`), and the goal step,
 *   where a connection made by *Another integration* waits for its task.
 * - **Connect & build**: the connect and building steps, then the result and the finish, which are
 *   the done screen.
 *
 * The person-facing words are the glossary's (CONTEXT.md): *harness* and *integration*, where the
 * frames say *agent* and *app*.
 */

export type SetupStage = 1 | 2 | 3 | 4;

export const SETUP_STAGES: readonly { stage: SetupStage; label: string }[] = [
  { stage: 1, label: "Harness" },
  { stage: 2, label: "Integration" },
  { stage: 3, label: "Tool" },
  { stage: 4, label: "Connect & build" },
];

/** The stage a step stands in; the vendor step's depends on whether a starter is chosen. */
export function setupStageOf(step: SetupStep, starterId: string | null | undefined): SetupStage {
  switch (step) {
    case "harness":
      return 1;
    case "vendor":
      return starterId ? 3 : 2;
    case "goal":
      return 3;
    default:
      return 4;
  }
}

/** Whether the step is the done screen, where the stepper shows every stage complete. */
export function setupDone(step: SetupStep): boolean {
  return step === "result" || step === "finish" || step === "completed";
}

export type SetupStageEntry = {
  stage: SetupStage;
  label: string;
  state: "done" | "current" | "upcoming";
};

/** The stepper's four entries for a step. */
export function setupStages(step: SetupStep, starterId: string | null | undefined) {
  const at = setupStageOf(step, starterId);
  const done = setupDone(step);
  return SETUP_STAGES.map(
    ({ stage, label }): SetupStageEntry => ({
      stage,
      label,
      state: done || stage < at ? "done" : stage === at ? "current" : "upcoming",
    }),
  );
}

/** The eyebrow over a step's title: "Step 3 of 4 · Tool", or "Setup complete" on the done screen. */
export function setupEyebrow(step: SetupStep, starterId: string | null | undefined): string {
  if (setupDone(step)) return "Setup complete";
  const at = setupStageOf(step, starterId);
  return `Step ${at} of ${SETUP_STAGES.length} · ${SETUP_STAGES[at - 1]?.label ?? ""}`;
}
