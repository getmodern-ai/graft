import { suggestedFirstSentence } from "@graft/core/setup/setup-prompt";

import type { ConnectionAccessView } from "./connection-queries";
import type { NewToolJob } from "./integration-queries";
import {
  type ProgressCard,
  progressCard,
  progressPart,
  SETUP_BUILD_PARTS,
  SETUP_STAGE_LABEL,
} from "./setup-progress";

/**
 * Get a new tool on an integration's page (GRA-320, Flow D; ADR 0024 as amended 2026-10-14): the
 * agent is picked before Create, and Create is that agent's build approval for the connection the
 * job builds against. These are the dialog's decisions as pure functions over the access reads
 * (GRA-296) and the jobs read (GRA-303); `components/integration/new-tool-dialog.tsx` draws them.
 */

/** An agent the dialog may build for, and the live connections of the integration it reaches. */
export type NewToolAgentChoice = {
  agent: { id: string; name: string };
  /** The connected connections in the agent's scope, in the page's order (oldest first). */
  connectionIds: string[];
  /** The agent's last call against the vendor; null when it never called. */
  lastUsedAt: string | null;
};

/**
 * Every active agent with at least one connected connection of the integration in its scope, in
 * agent order (oldest first, as the access read answers them). `connectionIds` is the page's
 * connected connections, oldest first; `accesses` holds one access read per connection, any
 * order, and a connection whose read has not answered reaches nobody yet. An agent whose scope
 * reaches none is not offered: its job would be refused for want of a connection in scope.
 */
export function newToolAgentChoices(
  connectionIds: readonly string[],
  accesses: readonly (ConnectionAccessView | undefined)[],
): NewToolAgentChoice[] {
  const byConnection = new Map(
    accesses.flatMap((access) => (access ? [[access.connectionId, access] as const] : [])),
  );
  const choices = new Map<string, NewToolAgentChoice>();
  for (const connectionId of connectionIds) {
    for (const row of byConnection.get(connectionId)?.agents ?? []) {
      const known = choices.get(row.agent.id);
      if (!row.inScope) {
        // Placed by its first appearance even when out of scope here, so the order is agent order.
        if (!known) {
          choices.set(row.agent.id, {
            agent: { id: row.agent.id, name: row.agent.name },
            connectionIds: [],
            lastUsedAt: row.lastUsedAt,
          });
        }
        continue;
      }
      if (known) {
        known.connectionIds.push(connectionId);
        known.lastUsedAt = newest(known.lastUsedAt, row.lastUsedAt);
      } else {
        choices.set(row.agent.id, {
          agent: { id: row.agent.id, name: row.agent.name },
          connectionIds: [connectionId],
          lastUsedAt: row.lastUsedAt,
        });
      }
    }
  }
  return [...choices.values()].filter((choice) => choice.connectionIds.length > 0);
}

function newest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * The picker's default: the agent that last used the integration, else the first offered (the
 * oldest active agent with the connection in scope). Null when nobody can build.
 */
export function defaultNewToolAgentId(choices: readonly NewToolAgentChoice[]): string | null {
  let pick: NewToolAgentChoice | null = null;
  for (const choice of choices) {
    if (choice.lastUsedAt === null) continue;
    if (pick?.lastUsedAt == null || choice.lastUsedAt > pick.lastUsedAt) pick = choice;
  }
  return (pick ?? choices[0])?.agent.id ?? null;
}

/**
 * The connection the job builds against, for the picked agent: the one the person chose when it
 * is in the agent's scope, else the agent's oldest connected one. The tool is bound to the
 * vendor and follows a reconnection (ADR 0007), so with several the choice decides only which
 * account the proof reads and the dry run reach.
 */
export function newToolConnectionId(
  choice: NewToolAgentChoice | undefined,
  chosen: string | null,
): string | null {
  if (!choice) return null;
  if (chosen && choice.connectionIds.includes(chosen)) return chosen;
  return choice.connectionIds[0] ?? null;
}

const WORKING = new Set(["queued", "running"]);

/** Whether the job is still being built. */
export function isNewToolJobWorking(job: Pick<NewToolJob, "status">): boolean {
  return WORKING.has(job.status);
}

/**
 * The job a reopened dialog or a reloaded page follows: the newest one still being built across
 * the integration's connections, or null. A finished job is never picked up again, so a dialog
 * the person closed on a result opens on a fresh description.
 */
export function runningNewToolJob(jobs: readonly NewToolJob[]): NewToolJob | null {
  let pick: NewToolJob | null = null;
  for (const job of jobs) {
    if (!isNewToolJobWorking(job)) continue;
    if (!pick || job.createdAt > pick.createdAt) pick = job;
  }
  return pick;
}

export type NewToolStep = "describe" | "building" | "ready" | "failed";

/** Which of the dialog's four views a followed job puts it in; none followed is the description. */
export function newToolStep(job: Pick<NewToolJob, "status"> | null): NewToolStep {
  if (!job) return "describe";
  if (job.status === "succeeded") return "ready";
  if (job.status === "failed") return "failed";
  return "building";
}

/** The tool a passed job landed, off `acquire_status`'s result; null for any other job. */
export function newToolOf(job: Pick<NewToolJob, "status" | "result"> | null) {
  const result = job?.status === "succeeded" ? job.result : undefined;
  return result && !("failure" in result) ? result : null;
}

/**
 * The first request to paste into the agent's chat (Flow D's *Try it in*): the goal as one
 * sentence that names Graft and the tool, so a chat that has not refreshed its tool list still
 * finds it. The goal's first letter is lowered only when its first word reads as an ordinary word.
 */
export function newToolPrompt(goal: string, wireName: string): string {
  const sentence = suggestedFirstSentence(goal);
  if (sentence === "") return `Using Graft, run the ${wireName} tool.`;
  const first = sentence.split(/\s/, 1)[0] ?? "";
  const ordinary = first !== "I" && /^[A-Z][a-z]*[,.!?]?$/.test(first);
  const lowered = ordinary ? sentence.charAt(0).toLowerCase() + sentence.slice(1) : sentence;
  return `Using Graft's ${wireName} tool, ${lowered}`;
}

/**
 * The ready view's line under its title: who can use the tool, and whether it will ask, by ADR
 * 0008's grain: a read never asks; any other tool asks the person once for the agent, unless an
 * answer for the integration already covers it, which the line does not claim either way.
 */
export function newToolReadyLine(
  agentName: string,
  annotations: { readOnlyHint: boolean },
): string {
  return annotations.readOnlyHint
    ? `${agentName} can use it now. It only reads, so it runs without asking.`
    : `${agentName} can use it now. It changes data, so you approve its first run unless you already allowed it.`;
}

/** "It tried 3 times." for the failure's lead; nothing before the first attempt. */
export function newToolAttemptsLine(attempts: number): string {
  if (attempts <= 0) return "";
  return attempts === 1 ? "It tried once." : `It tried ${attempts} times.`;
}

type JobRead = Parameters<typeof progressCard>[0];

/**
 * The card of the stage the job's last line was written in, whatever its status: for a failure,
 * where it stopped (`progressCard` labels every failure alike).
 */
function reachedCard(job: JobRead): ProgressCard {
  return progressCard(job && job.status === "failed" ? { ...job, status: "running" } : job);
}

/**
 * The progress row's note: the stage and where it sits in Setup's five parts while working
 * ("Checking it · 3 of 5"), and for a failure where the job stopped ("Stopped at checking it ·
 * 3 of 5"). A failure before any stage is the card's own label.
 */
export function newToolProgressNote(job: JobRead): string {
  const card = progressCard(job);
  if (card.kind === "passed") return card.label;
  const reached = reachedCard(job);
  const part = progressPart(reached);
  if (part === 0) return card.label;
  const where = `${part} of ${SETUP_BUILD_PARTS}`;
  if (card.kind === "working") return `${card.label} · ${where}`;
  return `Stopped at ${reached.label.charAt(0).toLowerCase()}${reached.label.slice(1)} · ${where}`;
}

/** How far the progress row's bar fills: the part reached (or stopped at), out of five. */
export function newToolProgressFraction(job: JobRead): number {
  const card = progressCard(job);
  if (card.kind === "passed") return 1;
  return progressPart(reachedCard(job)) / SETUP_BUILD_PARTS;
}

export type NewToolPartRow = {
  label: string;
  state: "done" | "current" | "pending" | "failed";
};

const PART_LABELS = [
  SETUP_STAGE_LABEL.docs,
  SETUP_STAGE_LABEL.write,
  SETUP_STAGE_LABEL.check,
  SETUP_STAGE_LABEL.prove,
  SETUP_STAGE_LABEL.publish,
] as const;

/**
 * The building view's checklist (Figma 2124:16898): Setup's five parts, those before the part
 * the job is in done, that part current (or failed, where the job stopped), the rest pending; a
 * pass is all five done. A job that skipped the documentation shows that part done once past it,
 * since the checklist says where the job stands, not every step it took.
 */
export function newToolPartRows(job: JobRead): NewToolPartRow[] {
  const card = progressCard(job);
  const reached = progressPart(reachedCard(job));
  return PART_LABELS.map((label, index) => {
    const part = index + 1;
    if (card.kind === "passed" || part < reached) return { label, state: "done" };
    if (part === reached) return { label, state: card.kind === "failed" ? "failed" : "current" };
    return { label, state: "pending" };
  });
}
