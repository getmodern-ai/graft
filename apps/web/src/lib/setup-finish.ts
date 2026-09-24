import { type SetupHarness, setupHarnessOf } from "@graft/core/setup/harness";

import type { Harness } from "./mcp-snippet";
import { shortFailure } from "./short-failure";

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

/**
 * What the finish step holds, per harness kind (GRA-215, *The finish is short*), and nothing else
 * beyond the step's one sentence and a failed build's notice:
 *
 * - `oauth`: the prompt with *Copy prompt*; the connector URL and the manual steps behind *Set it
 *   up by hand* (`byHand`), since the prompt walks the harness through them.
 * - `token`: the token block and the prompt, the configuration behind the same disclosure. The
 *   token block is `issued` once the token is in this page's hands (shown once), `to_issue` while
 *   the agent still awaits it, when the step's primary action issues it before the finish, and
 *   `saved` for an agent that already has one, whose token was shown when it was issued.
 * - `adopted`: the one request to ask in the chat, and nothing else.
 *
 * `primary` is the footer's action: *Issue the token* while the token block waits on it, so that
 * *Finish Setup* is always one press that leaves the page.
 */
export type FinishSections = {
  prompt: boolean;
  token: "issued" | "to_issue" | "saved" | null;
  byHand: "oauth" | "token" | null;
  askInChat: boolean;
  primary: "issue_token" | "finish";
};

export function finishSections(
  variant: FinishVariant,
  token: { issued: boolean; awaiting: boolean },
): FinishSections {
  if (variant === "adopted") {
    return { prompt: false, token: null, byHand: null, askInChat: true, primary: "finish" };
  }
  if (variant === "oauth") {
    return { prompt: true, token: null, byHand: "oauth", askInChat: false, primary: "finish" };
  }
  const block = token.issued ? "issued" : token.awaiting ? "to_issue" : "saved";
  return {
    prompt: true,
    token: block,
    byHand: "token",
    askInChat: false,
    primary: block === "to_issue" ? "issue_token" : "finish",
  };
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
 * job the person continued past still runs (*Continue while it runs*); `failed` when that job
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
    // One sentence, a page of HTML summarised (GRA-217), as the building step shows it.
    const { sentence } = shortFailure(context.job.failure, { fallback: "The tool did not pass." });
    return { kind: "failed", message: sentence };
  }
  // Queued, running, or passed and not yet learned by the record's next read.
  return { kind: "arriving" };
}

/**
 * The tool as the setup prompt names it (`setupPrompt`'s `tool`): the goal and the wire name once
 * it landed, the goal alone while it is arriving, so the prompt says it is still on its way, and
 * nothing when the job failed or there was none.
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
