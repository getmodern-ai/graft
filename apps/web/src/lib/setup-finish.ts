import { type SetupHarness, setupHarnessOf } from "@graft/core/setup/harness";

import type { Harness } from "./mcp-snippet";

/**
 * The finish step's decisions (GRA-208; GRA-202, *The finish step and the prompt*), pure so they are
 * tested: which instructions the step shows, where the tool stands, and what the setup prompt says
 * about it.
 */

/**
 * Which instructions the finish step shows: `token` for a static-token harness (the token once and
 * the configuration blocks), `oauth` for a harness that consents (the connector URL and the consent
 * steps), and `adopted` for a Setup that ran as an agent that existed before it (the record's
 * `harness` is null): that agent's harness is connected already, so the step says what to ask in
 * the chat instead.
 */
export type FinishVariant = "token" | "oauth" | "adopted";

export function finishVariant(harness: SetupHarness | null): FinishVariant {
  if (harness === null) return "adopted";
  return setupHarnessOf(harness).kind;
}

/** The configuration block's shape for a static-token harness (`mcp-snippet.ts`). */
export function snippetShapeOf(harness: SetupHarness): Harness {
  if (harness === "hermes" || harness === "openclaw") return harness;
  return "generic";
}

/** The part of `GET /api/setup/tool` these read. */
export type FinishToolFields = {
  goal: string | null;
  job: { status: string; failure: string | null } | null;
  tool: { wireName: string } | null;
};

/**
 * Where the tool stands on the finish step: `landed` once the record names it; `arriving` while the
 * job the person continued past still runs (*Continue while it builds*); `failed` when that job
 * failed after they continued, with its sentence; `none` with no job at all.
 */
export type ToolArrival =
  | { kind: "landed"; wireName: string }
  | { kind: "arriving" }
  | { kind: "failed"; message: string }
  | { kind: "none" };

export function toolArrival(context: FinishToolFields): ToolArrival {
  if (context.tool) return { kind: "landed", wireName: context.tool.wireName };
  if (!context.job) return { kind: "none" };
  if (context.job.status === "failed") {
    return { kind: "failed", message: context.job.failure ?? "The build did not pass." };
  }
  // Queued, running, or passed and not yet learned by the record's next read.
  return { kind: "arriving" };
}

/**
 * The tool as the setup prompt names it (`setupPrompt`'s `tool`): the goal and the wire name once
 * it landed, the goal alone while it is arriving, so the prompt says it is still being built, and
 * nothing when the build failed or there was none.
 */
export function promptToolOf(
  context: FinishToolFields,
): { goal: string; wireName?: string } | undefined {
  const arrival = toolArrival(context);
  if (!context.goal) return undefined;
  if (arrival.kind === "landed") return { goal: context.goal, wireName: arrival.wireName };
  if (arrival.kind === "arriving") return { goal: context.goal };
  return undefined;
}
