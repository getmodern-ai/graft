import type { GoalProposal, GoalProposalRequest } from "./types";

/**
 * What makes a proposed goal a chip (GRA-209, GRA-217), apart from the call that proposes it
 * (`./propose-goals.ts`), so the scripted backing answers through the same rules without importing
 * the AI SDK.
 *
 * **Every chip must end in a tool that runs with nothing to look up** (GRA-217). A chip for a
 * Sheets connection once read "List the spreadsheets I have", which is Drive's API on a host the
 * connection does not declare, and the next built a tool needing a spreadsheet's id and a range.
 * So a proposal carries the `task`, the `host` it would call and the `inputs` the person would
 * supply, and `groundedGoals` keeps it only when its host is one of the connection's and every
 * input carries a default (a city may; a spreadsheet's id never has one).
 */

/** The most goals a proposal answers. */
export const GOAL_PROPOSAL_MAX = 3;

/** The longest goal a chip carries; a longer one is not the short sentence asked for and is dropped. */
export const GOAL_PROPOSAL_MAX_LENGTH = 160;

/** One proposal as the model answers it, before `groundedGoals` judges it. */
export type RawGoalProposal = {
  task: string;
  /** The host the task's call goes to, which must be one of the connection's. */
  host: string;
  /** Every value the person would supply; each needs a default for the task to be kept. */
  inputs: readonly { name: string; default: string | null }[];
};

const SCHEME = /^[a-z][a-z0-9+.-]*$/;
const DIGITS = /^\d+$/;

/**
 * A host as the connection lists it: lower-case, no scheme, path or port. Linear string scans
 * rather than regular expressions over the whole value (CodeQL's polynomial-ReDoS on #172), since
 * the host is the model's answer and a run of `#` or `/` made the tail's `.*$` quadratic; the two
 * patterns left are anchored at both ends over one slice.
 */
export function bareHost(host: string): string {
  let rest = host.trim().toLowerCase();
  const scheme = rest.indexOf("://");
  if (scheme > 0 && SCHEME.test(rest.slice(0, scheme))) rest = rest.slice(scheme + 3);
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (char === "/" || char === "?" || char === "#") {
      rest = rest.slice(0, i);
      break;
    }
  }
  const colon = rest.lastIndexOf(":");
  if (colon !== -1 && DIGITS.test(rest.slice(colon + 1))) rest = rest.slice(0, colon);
  return rest;
}

/**
 * The proposals that end in a tool the person can run with nothing to look up: the host one of the
 * connection's, and every input carrying a non-empty default. Answers the tasks kept, in order, and
 * how many were dropped. Cleaning and the cap are `usableGoals`' after this.
 */
export function groundedGoals(
  proposals: readonly RawGoalProposal[],
  hosts: readonly string[],
): { tasks: string[]; dropped: number } {
  const allowed = new Set(hosts.map(bareHost));
  const tasks: string[] = [];
  let dropped = 0;
  for (const proposal of proposals) {
    const onHost = allowed.has(bareHost(proposal.host));
    const nothingToLookUp = proposal.inputs.every((input) => (input.default ?? "").trim() !== "");
    if (onHost && nothingToLookUp) tasks.push(proposal.task);
    else dropped += 1;
  }
  return { tasks, dropped };
}

const OPENING_QUOTES = new Set(['"', "'", "“"]);
const CLOSING_QUOTES = new Set(['"', "'", "”"]);

/**
 * The text less the quotes wrapping it, scanned from each end (CodeQL's polynomial-ReDoS on #172:
 * a trailing `["'”]+$` over a run of quotes followed by anything else was quadratic).
 */
function unquoted(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && OPENING_QUOTES.has(text[start] ?? "")) start += 1;
  while (end > start && CLOSING_QUOTES.has(text[end - 1] ?? "")) end -= 1;
  return text.slice(start, end);
}

/** One goal as a chip shows it, or null when it is not a usable one. */
function cleanGoal(raw: string): string | null {
  const goal = unquoted(raw.replace(/\s+/g, " ").trim()).trim();
  if (goal.length === 0 || goal.length > GOAL_PROPOSAL_MAX_LENGTH) return null;
  return goal;
}

/** The tasks as chips: cleaned, the curated goal and repeats dropped, at most three. */
export function usableGoals(raw: readonly string[], curatedGoal: string | null): string[] {
  const seen = new Set<string>();
  if (curatedGoal) seen.add(curatedGoal.trim().toLowerCase());
  const goals: string[] = [];
  for (const entry of raw) {
    const goal = cleanGoal(entry);
    if (!goal || seen.has(goal.toLowerCase())) continue;
    seen.add(goal.toLowerCase());
    goals.push(goal);
    if (goals.length === GOAL_PROPOSAL_MAX) break;
  }
  return goals;
}

/**
 * Proposals as a `GoalProposal`: grounded, then cleaned and capped. `declined` for an empty list,
 * `unusable` when nothing survived, `proposed` otherwise; `dropped` rides along when any proposal
 * was ungrounded. The provider's call and the scripted backing both answer through it.
 */
export function goalProposalOf(
  proposals: readonly RawGoalProposal[],
  request: Pick<GoalProposalRequest, "hosts" | "curatedGoal">,
  usage: GoalProposal["usage"],
): GoalProposal {
  if (proposals.length === 0) return { goals: [], outcome: "declined", usage };
  const { tasks, dropped } = groundedGoals(proposals, request.hosts);
  const goals = usableGoals(tasks, request.curatedGoal);
  const counted = dropped > 0 ? { dropped } : {};
  return goals.length > 0
    ? { goals, outcome: "proposed", usage, ...counted }
    : { goals: [], outcome: "unusable", usage, ...counted };
}
