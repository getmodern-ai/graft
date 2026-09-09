import type { AcquireStatus, AcquireSuccess } from "@graft/mcp";

import type { Scenario } from "./scenarios";
import type { ScenarioRun, ToolUse } from "./scorers";
import { AGENT, body, type World } from "./world";

/**
 * One scenario, start to finish, as a harness would drive it: `acquire`, then `acquire_status`
 * until the job settles — each new progress line handed to `onProgress`, which is what the agent
 * relays to the person — then the published tool called once as the agent would, with the ask
 * answered as the person would. What comes out is the run the scorers read.
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
  const startedAt = Date.now();
  const requestsBefore = world.requests.length;
  const eventsBefore = world.vendor.events.length;
  const ledgerBefore = world.store.usage.length;
  if (scenario.sdk) await world.placeSdk(scenario.sdk.package);

  const harness = await world.connect();
  try {
    const started = body<{ jobId: string }>(
      await harness.call("acquire", {
        connectionId: scenario.connectionId,
        goal: scenario.goal,
        hints: scenario.hints,
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

    const result =
      status.result && "tool" in status.result ? (status.result as AcquireSuccess) : null;
    const tool = result ? (world.store.tools.get(result.toolId) ?? null) : null;
    const version = tool?.currentVersionId
      ? (world.store.versions.get(tool.currentVersionId) ?? null)
      : null;

    let use: ToolUse | null = null;
    if (result && tool) {
      const [vendor, name] = result.tool.split("__");
      const input = fillInput(tool.inputSchema, scenario.use.values);
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
      status,
      job,
      attempts,
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
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ledger: world.store.usage.slice(ledgerBefore),
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
