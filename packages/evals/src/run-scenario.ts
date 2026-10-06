import type { AcquireStatus, AcquireSuccess } from "@graft/mcp";

import type { Scenario, Stage } from "./scenarios";
import type { ScenarioRun, ToolUse } from "./scorers";
import { AGENT, body, type World } from "./world";

/**
 * One scenario, start to finish, as a harness would drive it: `acquire`, then `acquire_status`
 * until the job settles — each new progress line handed to `onProgress`, which is what the agent
 * relays to the person — then the published tool called once as the agent would, with the ask
 * answered as the person would. What comes out is the run the scorers read.
 *
 * A chained scenario (GRA-191; ADR 0023) does that twice on the same world: the first tool's
 * answer is handed to the chain, which makes the second stage from it, the way an agent puts the
 * `blob://` ref one tool answered into the goal it hands `acquire` and the input it hands the tool
 * that follows. The first stage's run carries the second's as `next`.
 */

export type RunOptions = {
  onProgress?: (line: string) => void;
  /** How long to wait for the job before giving up on it; a real model takes minutes. */
  timeoutMs?: number;
  pollMs?: number;
};

type Awaiting = { error?: string; pendingActionId?: string };

export async function runScenario(
  world: World,
  scenario: Scenario,
  options: RunOptions = {},
): Promise<ScenarioRun> {
  const first = await runStage(world, scenario, scenario, options);
  if (!scenario.chain || !first.use) return first;
  const handoff = scenario.chain.handoff(first.use.final);
  if (handoff === null) return first;
  const next = await runStage(world, scenario, scenario.chain.stage(handoff), options);
  return { ...first, handoff, next };
}

async function runStage(
  world: World,
  scenario: Scenario,
  stage: Stage,
  options: RunOptions,
): Promise<ScenarioRun> {
  const startedAt = Date.now();
  const requestsBefore = world.requests.length;
  const eventsBefore = world.vendor.events.length;
  const ledgerBefore = world.store.usage.length;
  const turnsBefore = world.turns.length;
  const uploadsBefore = world.received.length;
  if (stage.sdk) await world.placeSdk(stage.sdk.package);

  const harness = await world.connect();
  try {
    const started = body<{ jobId: string }>(
      await harness.call("acquire", {
        connectionId: stage.connectionId,
        goal: stage.goal,
        hints: stage.hints,
      }),
    );
    if (typeof started.jobId !== "string") {
      throw new Error(`acquire did not start a job: ${JSON.stringify(started)}`);
    }
    const jobId = started.jobId;

    let status: AcquireStatus = body<AcquireStatus>(
      await harness.call("acquire_status", { jobId }),
    );
    let relayed = 0;
    const deadline = startedAt + (options.timeoutMs ?? 20 * 60 * 1000);
    while (status.status === "queued" || status.status === "running") {
      for (const line of status.progress.slice(relayed)) options.onProgress?.(line);
      relayed = status.progress.length;
      if (Date.now() > deadline) throw new Error("the job did not settle within the timeout");
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1_500));
      status = body<AcquireStatus>(await harness.call("acquire_status", { jobId }));
    }
    for (const line of status.progress.slice(relayed)) options.onProgress?.(line);
    // The settle point: the job's last row, its result trace, is written before its status turns
    // terminal, and the tool's first row, its ask, is not written until the use below. The record's
    // length here divides the two whatever their timestamps say (GRA-63).
    const settled = world.record.length;

    const result =
      status.result && "tool" in status.result ? (status.result as AcquireSuccess) : null;
    const tool = result ? (world.store.tools.get(result.toolId) ?? null) : null;
    const version = tool?.currentVersionId
      ? (world.store.versions.get(tool.currentVersionId) ?? null)
      : null;

    let use: ToolUse | null = null;
    if (result && tool) {
      const [vendor, name] = result.tool.split("__");
      const input = fillInput(tool.inputSchema, stage.use.values);
      const call = () => harness.call("run_tool", { vendor, name, input });
      const first = body<Awaiting>(await call());
      let ask = null;
      let answeredAt: number | null = null;
      let second: unknown = null;
      if (first.error === "awaiting_approval" && typeof first.pendingActionId === "string") {
        ask = world.store.pendingActions.get(first.pendingActionId) ?? null;
        await world.answerToolAsk(first.pendingActionId, tool.id);
        answeredAt = Date.now();
        second = body(await call());
      }
      use = { input, first, ask, answeredAt, second, final: second ?? first };
    }

    const attempts = [...world.store.acquireAttempts.values()]
      .filter((row) => row.jobId === jobId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
    const tokens = attempts.reduce(
      (sum, a) => ({ input: sum.input + a.inputTokens, output: sum.output + a.outputTokens }),
      { input: 0, output: 0 },
    );
    const job = world.store.acquireJobs.get(jobId) ?? null;

    return {
      scenario,
      stage,
      status,
      job,
      attempts,
      settled,
      traces: world.store.acquireTraces.filter((row) => row.jobId === jobId),
      requests: world.requests.slice(requestsBefore),
      events: world.vendor.events.slice(eventsBefore),
      tool,
      version,
      use,
      asks: [...world.store.pendingActions.values()]
        .filter(
          (row) =>
            row.agentId === AGENT &&
            row.kind === "tool" &&
            tool !== null &&
            row.payload.toolId === tool.id,
        )
        .map((row) => ({ ...row, position: positionOf(world, row) }))
        .sort((a, b) => a.position - b.position),
      ledger: world.store.usage.slice(ledgerBefore),
      model: world.turns.slice(turnsBefore),
      uploads: world.received.slice(uploadsBefore),
      handoff: null,
      next: null,
      ms: Date.now() - startedAt,
      // The job's own figure is the total every turn was charged against the ceiling; the attempts'
      // split is known only for attempts that finished, so an abandoned one leaves it short.
      tokens: {
        input: tokens.input,
        output: tokens.output,
        total: job?.tokenSpend ?? tokens.input + tokens.output,
      },
    };
  } finally {
    await harness.close();
  }
}

/** A pending action's position in the world's record; every one the loop wrote has one, so a missing one is the harness's bug. */
function positionOf(world: World, row: { id: string }): number {
  const position = world.record.positionOf(row.id);
  if (position === null) throw new Error(`the world never recorded pending action ${row.id}`);
  return position;
}

/**
 * The input an agent would send: every property the published schema declares, filled from what the
 * agent knows under whichever name the model chose for it. Properties the agent has no value for are
 * left out; a required one among them makes the call refuse, which the scorer then says.
 */
export function fillInput(
  schema: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return {};
  const input: Record<string, unknown> = {};
  for (const property of Object.keys(properties)) {
    if (property in values) input[property] = values[property];
  }
  return input;
}
