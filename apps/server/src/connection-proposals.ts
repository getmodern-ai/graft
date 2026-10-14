import { randomUUID } from "node:crypto";

import { ServiceError } from "@graft/core";
import {
  ACQUIRE_UNCONFIGURED,
  acquireConfigured,
  type DocsProposal,
  type DocsProposalDeps,
  type DocsProposalFailure,
  type DocsProposalFound,
  type DocsProposalResult,
  type DocsProposalStage,
  type DocsProposalStats,
  proposeConnectionFromDocs,
  readDocsProposalInput,
} from "@graft/mcp";

/**
 * The console's connection proposal from an API's docs (GRA-299, Flow C) on the server: a short job
 * the console starts and polls. `@graft/mcp`'s `proposeConnectionFromDocs` does the work (the pages,
 * the model, the connection rules, the address check); this file holds the jobs.
 *
 * **Held in this process's memory, never the database.** A proposal is a few seconds of a person's
 * attention, so a job is kept for `CONNECTION_PROPOSAL_TTL_MS` from when it started and then
 * forgotten, and a restart loses one in flight: the console starts again. As
 * `setup-build.ts`'s goal-suggestion memo, two replicas hold two sets; a poll that lands on the
 * other replica is a 404, which the hosted form's sticky routing makes rare (and the console's
 * answer to a 404 is to start again).
 *
 * **At most one in flight per person**, which is the whole rate limit: a start while one runs is
 * refused `proposal_running` with the running job's id. A job is the starter's alone: another
 * person's id answers the same 404 as an id that never existed.
 */

/** How long a job is answered after it started, settled or not. */
export const CONNECTION_PROPOSAL_TTL_MS = 15 * 60 * 1000;
/**
 * How long a job may run before it is failed, whatever it waits on (Greptile on #231): the page's
 * DNS lookup and the person's model key are read before the reader's and the model's own bounds
 * start, so the whole job is bounded here, which is what lets a running job never be evicted.
 */
export const CONNECTION_PROPOSAL_DEADLINE_MS = 120_000;
/** How many jobs the process holds before the oldest is dropped. */
export const CONNECTION_PROPOSAL_MAX = 1000;

/** The refusal's reason for a start while the person's last job still runs. */
export const PROPOSAL_RUNNING = "proposal_running";
/** The refusal's reason when every slot the process holds is a running job. */
export const PROPOSALS_BUSY = "proposals_busy";

/** What the console shows when no model can read the docs: the variables the operator sets. */
export const CONNECTION_PROPOSAL_UNCONFIGURED_MESSAGE =
  "This deployment has no model configured, so Graft cannot read an API's documentation for you. Whoever runs this Graft sets GRAFT_MODEL_BACKEND=provider with GRAFT_MODEL_PROVIDER and GRAFT_MODEL_API_KEY, then restarts it. You can still add the connection by hand.";

/**
 * `GET /api/connection-proposals`: whether the console may offer the flow at all, the same model
 * check `acquire`'s door makes (`acquireConfigured`), and the person's job still running, if any.
 */
export type ConnectionProposalAvailability =
  | { available: true; running: string | null }
  | { available: false; reason: typeof ACQUIRE_UNCONFIGURED; message: string };

/** `POST /api/connection-proposals`'s answer: the job's id, to poll. */
export type ConnectionProposalStarted = { id: string };

/**
 * `GET /api/connection-proposals/:id`: where the job stands. `stage` is the checklist line in
 * progress while `running`, and the last one reached once settled; `found` fills in as the stages
 * pass; `proposal` is set once `ready`, `failure` once `failed`.
 */
export type ConnectionProposalState = {
  id: string;
  status: "running" | "ready" | "failed";
  stage: DocsProposalStage;
  name: string;
  docsUrl: string;
  found: DocsProposalFound;
  proposal: DocsProposal | null;
  /** Hosts whose name did not resolve when checked, for the person to look at before adding a key. */
  unresolvedHosts: string[];
  failure: DocsProposalFailure | null;
  startedAt: Date;
  settledAt: Date | null;
};

/** What a settled job reports for the log: counts and kinds, never the pages, the name or the proposal. */
export type ConnectionProposalSettled = {
  id: string;
  personId: string;
  status: "ready" | "failed";
  stage: DocsProposalStage;
  reason: DocsProposalFailure["reason"] | null;
  unresolvedHosts: number;
  durationMs: number;
  /** A throw's message, when the job failed for a reason that is not the person's. */
  error?: string;
} & DocsProposalStats;

export type ConnectionProposalStore = {
  availability(personId: string): ConnectionProposalAvailability;
  start(personId: string, body: { name: string; docsUrl: string }): ConnectionProposalStarted;
  get(personId: string, id: string): ConnectionProposalState;
  /** Resolves once every job started so far has settled; a test's seam. */
  idle(): Promise<void>;
};

export type ConnectionProposalStoreOptions = {
  /** The model and the page reader `acquire` uses (`McpDeps`); absent, the flow is unavailable. */
  deps: DocsProposalDeps | null;
  onSettled?: (event: ConnectionProposalSettled) => void;
  ttlMs?: number;
  max?: number;
  /** The whole job's bound; `CONNECTION_PROPOSAL_DEADLINE_MS` when absent. */
  deadlineMs?: number;
  now?: () => Date;
};

type Held = { personId: string; state: ConnectionProposalState; done: Promise<void> };

export function createConnectionProposalStore(
  options: ConnectionProposalStoreOptions,
): ConnectionProposalStore {
  const ttlMs = options.ttlMs ?? CONNECTION_PROPOSAL_TTL_MS;
  const max = options.max ?? CONNECTION_PROPOSAL_MAX;
  const now = options.now ?? (() => new Date());
  const jobs = new Map<string, Held>();

  // A running job is never forgotten, by the window or by the cap (Greptile on #231): its person
  // would poll a 404 while it ran on, and could start a second beside it. Every stage is bounded, so
  // a running job settles.
  const live = (held: Held | undefined): held is Held =>
    held !== undefined &&
    (held.state.status === "running" || now().getTime() - held.state.startedAt.getTime() < ttlMs);

  /** Room for one more job: the expired forgotten, then the oldest settled; false when every slot runs. */
  const makeRoom = (): boolean => {
    for (const [id, held] of jobs) if (!live(held)) jobs.delete(id);
    for (const [id, held] of jobs) {
      if (jobs.size < max) break;
      if (held.state.status !== "running") jobs.delete(id);
    }
    return jobs.size < max;
  };

  const runningFor = (personId: string): Held | null => {
    for (const held of jobs.values()) {
      if (held.personId === personId && held.state.status === "running" && live(held)) return held;
    }
    return null;
  };

  const usable = (): DocsProposalDeps | null =>
    options.deps && acquireConfigured(options.deps) ? options.deps : null;

  return {
    availability(personId) {
      if (!usable()) {
        return {
          available: false,
          reason: ACQUIRE_UNCONFIGURED,
          message: CONNECTION_PROPOSAL_UNCONFIGURED_MESSAGE,
        };
      }
      return { available: true, running: runningFor(personId)?.state.id ?? null };
    },

    start(personId, body) {
      const deps = usable();
      if (!deps) {
        throw new ServiceError("CONFLICT", CONNECTION_PROPOSAL_UNCONFIGURED_MESSAGE, {
          details: { reason: ACQUIRE_UNCONFIGURED },
        });
      }
      const input = readDocsProposalInput(body);
      if (!input.ok) {
        throw new ServiceError("BAD_REQUEST", input.message, {
          details: { reason: input.reason, field: input.field },
        });
      }
      const running = runningFor(personId);
      if (running) {
        throw new ServiceError(
          "CONFLICT",
          "Graft is already reading documentation for you. Wait for it to finish, then start again.",
          { details: { reason: PROPOSAL_RUNNING, id: running.state.id } },
        );
      }
      if (!makeRoom()) {
        throw new ServiceError(
          "CONFLICT",
          "Graft is reading documentation for too many people at once. Try again in a minute.",
          { details: { reason: PROPOSALS_BUSY } },
        );
      }
      const state: ConnectionProposalState = {
        id: `cprop_${randomUUID()}`,
        status: "running",
        stage: "reading_docs",
        name: input.name,
        docsUrl: input.docsUrl,
        found: { docsHost: null, scheme: null, primaryHost: null },
        proposal: null,
        unresolvedHosts: [],
        failure: null,
        startedAt: now(),
        settledAt: null,
      };
      const settle = (
        status: "ready" | "failed",
        patch: Partial<ConnectionProposalState>,
        stats: DocsProposalStats,
        error?: string,
      ) => {
        // The first settle wins: a job the deadline failed stays failed when its work lands late.
        if (state.status !== "running") return;
        Object.assign(state, patch, { status, settledAt: now() });
        options.onSettled?.({
          id: state.id,
          personId,
          status,
          stage: state.stage,
          reason: state.failure?.reason ?? null,
          unresolvedHosts: state.unresolvedHosts.length,
          durationMs: state.settledAt ? state.settledAt.getTime() - state.startedAt.getTime() : 0,
          ...stats,
          ...(error === undefined ? {} : { error }),
        });
      };
      const settleWith = (result: DocsProposalResult) =>
        result.ok
          ? settle(
              "ready",
              {
                found: result.found,
                proposal: result.proposal,
                unresolvedHosts: result.unresolvedHosts,
              },
              result.stats,
            )
          : settle("failed", { found: result.found, failure: result.failure }, result.stats);
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Aborted with the deadline, so the work it overtook stops at its next step.
      const abandon = new AbortController();
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => {
          abandon.abort();
          resolve("deadline");
        }, options.deadlineMs ?? CONNECTION_PROPOSAL_DEADLINE_MS);
      });
      const work = proposeConnectionFromDocs(
        { personId, name: input.name, docsUrl: input.docsUrl, signal: abandon.signal },
        deps,
        (stage, found) => {
          if (state.status !== "running") return;
          state.stage = stage;
          state.found = found;
        },
      );
      const done = Promise.race([work, deadline])
        .then(
          (result) =>
            result === "deadline"
              ? settle(
                  "failed",
                  {
                    failure: {
                      reason: "proposal_timeout",
                      message:
                        "Graft took too long to read the documentation. Try again, or set it up by hand.",
                    },
                  },
                  {
                    pages: 0,
                    characters: 0,
                    outcome: null,
                    usage: { inputTokens: 0, outputTokens: 0 },
                  },
                )
              : settleWith(result),
          (error: unknown) =>
            // Not a reason a person can act on: the job says so and the log carries the message.
            settle(
              "failed",
              {
                failure: {
                  reason: "model_failed",
                  message: "Something went wrong while Graft read the documentation. Try again.",
                },
              },
              {
                pages: 0,
                characters: 0,
                outcome: null,
                usage: { inputTokens: 0, outputTokens: 0 },
              },
              error instanceof Error ? error.message : String(error),
            ),
        )
        .finally(() => clearTimeout(timer));
      jobs.set(state.id, { personId, state, done });
      return { id: state.id };
    },

    get(personId, id) {
      const held = jobs.get(id);
      if (!live(held) || held.personId !== personId) {
        throw new ServiceError("NOT_FOUND", "No such connection proposal");
      }
      return { ...held.state, found: { ...held.state.found } };
    },

    async idle() {
      await Promise.all([...jobs.values()].map((held) => held.done));
    },
  };
}
