import { WAIT_SLACK_SECONDS } from "./bounds";
import { isPlainObject } from "./result";
import { isPolledProcess } from "./sandbox";

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
  /**
   * The blob budget the door handed a run of this agent's (GRA-187; `blob-door.ts`), held from now
   * until the returned function runs. Two runs admitted from the same rows would otherwise each be
   * handed the whole remainder (Greptile on #148): the door subtracts `outstandingBudget` first.
   * A run that starts detached moves its grant onto the process name (`track`'s `budgetBytes`)
   * before releasing this one, so the agent is never momentarily ungranted between the two.
   */
  grant(agentId: string, budgetBytes: number): () => void;
  /** Bytes granted to this agent's runs still in flight: every open grant and every tracked process's. */
  outstandingBudget(agentId: string): number;
  /**
   * Run `work` after every earlier `admit` of this agent's has settled, and before any later one
   * starts: the door's admission and its grant as one step (`admitUnderGrant`; GRA-200, after
   * Greptile on #157). The door reads `outstandingBudget` and answers a budget, and the caller
   * grants it one await later; two admissions of one agent interleaved across that await both read
   * the remainder before either reserved it, and were both handed the whole of it.
   */
  admit<T>(agentId: string, work: () => Promise<T>): Promise<T>;
  /**
   * A detached process is in flight by name until settled, or until `ttlMs` has passed; the budget
   * the door handed its run, when it has one, is outstanding for as long.
   */
  track(agentId: string, processName: string, ttlMs: number, budgetBytes?: number): void;
  /** `wait_for_process` saw the process finish. A name not tracked is ignored. */
  settle(agentId: string, processName: string): void;
  has(agentId: string): boolean;
  /** Cancel every timer. For tests and shutdown. */
  close(): void;
};

type Detached = { timer: ReturnType<typeof setTimeout>; budgetBytes: number };

type AgentHolds = {
  calls: number;
  /** The sum of every open call grant (`grant`), in bytes. */
  granted: number;
  detached: Map<string, Detached>;
};

export function createInFlightRegistry(): InFlightRegistry {
  const agents = new Map<string, AgentHolds>();
  /** The tail of each agent's admission chain (`admit`); an entry is dropped once its chain drains. */
  const admissions = new Map<string, Promise<void>>();

  const holdsOf = (agentId: string): AgentHolds => {
    let holds = agents.get(agentId);
    if (!holds) {
      holds = { calls: 0, granted: 0, detached: new Map() };
      agents.set(agentId, holds);
    }
    return holds;
  };

  const prune = (agentId: string, holds: AgentHolds) => {
    if (holds.calls === 0 && holds.granted === 0 && holds.detached.size === 0) {
      agents.delete(agentId);
    }
  };

  const settle = (agentId: string, processName: string) => {
    const holds = agents.get(agentId);
    if (!holds) return;
    const entry = holds.detached.get(processName);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
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
    grant(agentId, budgetBytes) {
      const holds = holdsOf(agentId);
      const bytes = Math.max(0, budgetBytes);
      holds.granted += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds.granted -= bytes;
        prune(agentId, holds);
      };
    },
    outstandingBudget(agentId) {
      const holds = agents.get(agentId);
      if (!holds) return 0;
      let total = holds.granted;
      for (const entry of holds.detached.values()) total += entry.budgetBytes;
      return total;
    },
    admit(agentId, work) {
      const previous = admissions.get(agentId) ?? Promise.resolve();
      // A failed admission ahead of this one is that caller's to answer; the chain goes on.
      const result = previous.then(work);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      admissions.set(agentId, settled);
      settled.then(() => {
        if (admissions.get(agentId) === settled) admissions.delete(agentId);
      });
      return result;
    },
    track(agentId, processName, ttlMs, budgetBytes = 0) {
      const holds = holdsOf(agentId);
      const previous = holds.detached.get(processName);
      if (previous !== undefined) clearTimeout(previous.timer);
      const timer = setTimeout(() => settle(agentId, processName), Math.max(0, ttlMs));
      // A tracked process must not hold the server open past its last session.
      timer.unref?.();
      holds.detached.set(processName, { timer, budgetBytes: Math.max(0, budgetBytes) });
    },
    settle,
    has(agentId) {
      const holds = agents.get(agentId);
      return holds !== undefined && (holds.calls > 0 || holds.detached.size > 0);
    },
    close() {
      for (const holds of agents.values()) {
        for (const entry of holds.detached.values()) clearTimeout(entry.timer);
        holds.detached.clear();
      }
      agents.clear();
    },
  };
}

/**
 * The door's admission and its grant as one step for the agent (GRA-200, after Greptile on #157):
 * `admit` is the door (`blob-door.ts`'s `admitBlobs`, over whatever input the path carries), run
 * under the agent's admission chain, and an admission's budget is granted before the chain moves
 * on, so the next admission reads it in `outstandingBudget`. A refusal grants nothing. The
 * returned `release` is the grant's, for the caller's `finally`; with no registry there is nothing
 * to reserve against and it is a no-op. Every path that passes the door takes it through here
 * (`run.ts`, `tools/execute.ts`, `run_command`).
 */
export async function admitUnderGrant<A extends { budgetBytes: number }, R>(
  registry: InFlightRegistry | undefined,
  agentId: string,
  admit: () => Promise<{ ok: true; admission: A } | { ok: false; refusal: R }>,
): Promise<{ ok: true; admission: A; release: () => void } | { ok: false; refusal: R }> {
  const step = async () => {
    const door = await admit();
    if (!door.ok) return door;
    const release = registry?.grant(agentId, door.admission.budgetBytes) ?? (() => {});
    return { ok: true as const, admission: door.admission, release };
  };
  return registry ? registry.admit(agentId, step) : step();
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
 * two. `budgetBytes` is the blob budget the door handed the call (GRA-200; `blob-door.ts`): a
 * detached start carries it on the process name, as `run.ts`'s does, so the by-hand paths' grant
 * outlives the call for as long as the process may write.
 */
export function trackDetachedStart(
  registry: InFlightRegistry | undefined,
  agentId: string,
  answer: unknown,
  budgetBytes?: number,
): void {
  // `runCommand` answers `{ answer, blobs }` since GRA-186 (`sandbox.ts`'s `PolledProcess`); the
  // detached start is the `answer` inside it.
  const start = isPolledProcess(answer) ? answer.answer : answer;
  if (!registry || !isPlainObject(start) || start.status !== "running") return;
  if (typeof start.processName !== "string" || typeof start.timeoutSeconds !== "number") return;
  registry.track(agentId, start.processName, detachedHoldMs(start.timeoutSeconds), budgetBytes);
}

/**
 * Run `work` with the agent held, and keep the hold by process name when the answer is a detached
 * start — the one wrapper the call paths share (`run.ts`, `tools/execute.ts`, `run_command`), so
 * none can hold and forget to release, or release before the detached hold is in place. A caller
 * that took a budget grant for the call passes `budgetBytes`, and a detached start keeps it too
 * (`trackDetachedStart`); the caller releases its own grant once this returns, so the two never
 * leave a gap.
 */
export async function heldInFlight<T>(
  registry: InFlightRegistry | undefined,
  agentId: string,
  work: () => Promise<T>,
  budgetBytes?: number,
): Promise<T> {
  const release = registry?.begin(agentId);
  try {
    const answer = await work();
    trackDetachedStart(registry, agentId, answer, budgetBytes);
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
