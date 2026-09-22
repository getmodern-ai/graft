import { WAIT_SLACK_SECONDS } from "./bounds";
import { isPlainObject } from "./result";

/**
 * Which agents have a run in flight — the guard ADR 0009 puts on the rule: demotion is deferred
 * while the agent has a run in flight, so a tool is not taken out of the list from under the turn
 * that is using it.
 *
 * One registry per process, held in `McpDeps` (`inFlight`), because it counts across every session
 * of an agent: a harness that reconnected mid-run holds the same agent. Two kinds of hold. A **call**
 * — an authored tool's run, `run_tool`, an execute tool, `run_command` — holds from `begin` until its
 * release runs. A **detached process** holds by name from its start until `wait_for_process` reports
 * it finished (`settle`) or its own timeout has passed — the kill bound plus the poll's slack, after
 * which nothing can still be running under that name.
 *
 * In-process on purpose: the alpha's jobs and sweeps run on a plain scheduler inside the server
 * (GRA-1, "No Temporal"), so this process is the only one that starts runs and the only one that
 * sweeps. A durable engine (roadmap) moves this record into its own store, and the sweep, which only
 * asks `has`, would not change. The cost is a restart: a detached process that outlives the server is
 * forgotten, and the next sweep may demote its tool. The run itself is unaffected — it resolved the
 * tool before it started — and the tool is one `promote` away (ADR 0009).
 */

export type InFlightRegistry = {
  /** A call is in flight from now until the returned function runs; running it twice is a no-op. */
  begin(agentId: string): () => void;
  /** A detached process is in flight by name until settled, or until `ttlMs` has passed. */
  track(agentId: string, processName: string, ttlMs: number): void;
  /** `wait_for_process` saw the process finish. A name not tracked is ignored. */
  settle(agentId: string, processName: string): void;
  has(agentId: string): boolean;
  /** Cancel every timer. For tests and shutdown. */
  close(): void;
};

type AgentHolds = {
  calls: number;
  detached: Map<string, ReturnType<typeof setTimeout>>;
};

export function createInFlightRegistry(): InFlightRegistry {
  const agents = new Map<string, AgentHolds>();

  const holdsOf = (agentId: string): AgentHolds => {
    let holds = agents.get(agentId);
    if (!holds) {
      holds = { calls: 0, detached: new Map() };
      agents.set(agentId, holds);
    }
    return holds;
  };

  const prune = (agentId: string, holds: AgentHolds) => {
    if (holds.calls === 0 && holds.detached.size === 0) agents.delete(agentId);
  };

  const settle = (agentId: string, processName: string) => {
    const holds = agents.get(agentId);
    if (!holds) return;
    const timer = holds.detached.get(processName);
    if (timer === undefined) return;
    clearTimeout(timer);
    holds.detached.delete(processName);
    prune(agentId, holds);
  };

  return {
    begin(agentId) {
      const holds = holdsOf(agentId);
      holds.calls += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds.calls -= 1;
        prune(agentId, holds);
      };
    },
    track(agentId, processName, ttlMs) {
      const holds = holdsOf(agentId);
      const previous = holds.detached.get(processName);
      if (previous !== undefined) clearTimeout(previous);
      const timer = setTimeout(() => settle(agentId, processName), Math.max(0, ttlMs));
      // A tracked process must not hold the server open past its last session.
      timer.unref?.();
      holds.detached.set(processName, timer);
    },
    settle,
    has(agentId) {
      const holds = agents.get(agentId);
      return holds !== undefined && (holds.calls > 0 || holds.detached.size > 0);
    },
    close() {
      for (const holds of agents.values()) {
        for (const timer of holds.detached.values()) clearTimeout(timer);
        holds.detached.clear();
      }
      agents.clear();
    },
  };
}

/**
 * How long a detached process may be held for: its kill bound plus the slack a poll outlasts it by,
 * so a process seen "killed" by `wait_for_process` and one nobody polled again release at the same
 * moment. `bounds.ts` owns both numbers.
 */
export function detachedHoldMs(timeoutSeconds: number): number {
  return (timeoutSeconds + WAIT_SLACK_SECONDS) * 1_000;
}

/**
 * Hold a detached start, read from the answer the tool is about to return — `describeDetachedStart`'s
 * shape (`sandbox.ts`): `status: "running"` with a `processName` and its `timeoutSeconds`. Anything
 * else — a waited command's result, a refusal, a failure — holds nothing, because the call's own hold
 * covered it. Called before the call's release, so the agent is never momentarily unheld between the
 * two.
 */
export function trackDetachedStart(
  registry: InFlightRegistry | undefined,
  agentId: string,
  answer: unknown,
): void {
  // `runCommand` answers `{ answer, blobs }` since GRA-186 (`sandbox.ts`'s `PolledProcess`); the
  // detached start is the `answer` inside it.
  const start =
    isPlainObject(answer) && "answer" in answer && Array.isArray(answer.blobs)
      ? answer.answer
      : answer;
  if (!registry || !isPlainObject(start) || start.status !== "running") return;
  if (typeof start.processName !== "string" || typeof start.timeoutSeconds !== "number") return;
  registry.track(agentId, start.processName, detachedHoldMs(start.timeoutSeconds));
}

/**
 * Run `work` with the agent held, and keep the hold by process name when the answer is a detached
 * start — the one wrapper the call paths share (`run.ts`, `tools/execute.ts`, `run_command`), so
 * none can hold and forget to release, or release before the detached hold is in place.
 */
export async function heldInFlight<T>(
  registry: InFlightRegistry | undefined,
  agentId: string,
  work: () => Promise<T>,
): Promise<T> {
  const release = registry?.begin(agentId);
  try {
    const answer = await work();
    trackDetachedStart(registry, agentId, answer);
    return answer;
  } finally {
    release?.();
  }
}

/** A `wait_for_process` answer that says the process is done, in any of the three ways it can be. */
export function isSettledProcess(answer: unknown): boolean {
  return (
    isPlainObject(answer) &&
    (answer.status === "completed" || answer.status === "failed" || answer.status === "killed")
  );
}
