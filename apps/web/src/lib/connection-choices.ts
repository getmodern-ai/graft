import type { AskOrigin } from "./ask-answered-copy";

/**
 * What a connection card may grant with its answer, and what it sends (GRA-274). A connection
 * confirmation can carry two standing approvals for the asking agent: the build approval (GRA-75;
 * ADR 0008 as amended 2026-09-18) and the integration's tools without asking (GRA-239; the
 * amendment of 2026-10-09). Both are the person's (ADR 0006), so **a grant is sent only when the
 * person was shown the choice**: a card draws the line for every choice `connectionChoicesShown`
 * says it shows, and sends what `connectionChoicesSent` answers, never its state directly.
 *
 * Setup's connect cards (`origin: "setup"`) show the tools line, pre-ticked as everywhere else, and
 * not the build choice: in Setup, Build (or the build a chosen task plans) is the build approval
 * (ADR 0024, *Build is the build approval*), recorded by `startSetupBuild`, so the connect sends
 * none. A widening is drawn as the inbox draws it, in Setup too, and shows both.
 */

export type ConnectionChoices = { approveBuild: boolean; allowVendor: boolean };

export function connectionChoicesShown(input: {
  origin: AskOrigin;
  widens?: boolean;
}): ConnectionChoices {
  if (input.origin === "setup" && !input.widens) return { approveBuild: false, allowVendor: true };
  return { approveBuild: true, allowVendor: true };
}

/** The choices as the card sends them: a tick the person was not shown is never a yes. */
export function connectionChoicesSent(
  shown: ConnectionChoices,
  ticked: ConnectionChoices,
): ConnectionChoices {
  return {
    approveBuild: shown.approveBuild && ticked.approveBuild,
    allowVendor: shown.allowVendor && ticked.allowVendor,
  };
}
