import { describe, expect, it } from "vitest";

import { CONFORMANCE_CONTEXT } from "./conformance";
import { createRoutedModel, type ModelRoute, ModelUnavailableError } from "./routed";
import type { ModelAdapter, ModelJobContext, ModelSituation } from "./types";

/**
 * The per-person router (ADR 0014): a person's own key answers that person's jobs and nobody
 * else's, the fixed model answers the rest, and a job with neither fails saying so.
 */

/** An adapter that records which jobs it opened and what it was asked. */
function recording(name: string): ModelAdapter & { opened: string[]; turns: string[] } {
  const opened: string[] = [];
  const turns: string[] = [];
  return {
    name,
    opened,
    turns,
    open(context) {
      opened.push(`${context.jobId}:${context.personId}`);
      return {
        async turn(situation) {
          turns.push(`${context.jobId}:${situation.kind}`);
          return {
            answer: { kind: "give_up", reason: `${name} answered` },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
    },
  };
}

const job = (jobId: string, personId: string): ModelJobContext => ({
  ...CONFORMANCE_CONTEXT,
  jobId,
  personId,
});
const GOAL: ModelSituation = { kind: "goal" };

describe("createRoutedModel", () => {
  it("routes a person's job to that person's own adapter and another person's to the fixed one", async () => {
    const own = recording("anthropic:own-key");
    const fixed = recording("openai:fixed");
    const asked: string[] = [];
    const routes: ModelRoute[] = [];
    const routed = createRoutedModel({
      fixed,
      resolve: async (personId) => {
        asked.push(personId);
        return personId === "person_a" ? own : null;
      },
      onRoute: (route) => routes.push(route),
    });

    const a = await routed.open(job("job_1", "person_a")).turn(GOAL);
    const b = await routed.open(job("job_2", "person_b")).turn(GOAL);

    expect(a.answer).toEqual({ kind: "give_up", reason: "anthropic:own-key answered" });
    expect(b.answer).toEqual({ kind: "give_up", reason: "openai:fixed answered" });
    // Person A's adapter saw A's job and no other; the fixed one saw B's alone.
    expect(own.opened).toEqual(["job_1:person_a"]);
    expect(fixed.opened).toEqual(["job_2:person_b"]);
    // The resolver was handed the job's person and nothing else.
    expect(asked).toEqual(["person_a", "person_b"]);
    expect(routes).toEqual([
      { jobId: "job_1", personId: "person_a", source: "person", adapter: "anthropic:own-key" },
      { jobId: "job_2", personId: "person_b", source: "fixed", adapter: "openai:fixed" },
    ]);
  });

  it("resolves once per conversation, on the first turn, and keeps the delegate for the rest", async () => {
    const own = recording("own");
    let resolved = 0;
    const routed = createRoutedModel({
      fixed: null,
      resolve: async () => {
        resolved += 1;
        return own;
      },
    });
    const conversation = routed.open(job("job_1", "person_a"));
    expect(resolved).toBe(0);
    await conversation.turn(GOAL);
    await conversation.turn({ kind: "docs", pages: [] });
    expect(resolved).toBe(1);
    expect(own.opened).toEqual(["job_1:person_a"]);
    expect(own.turns).toEqual(["job_1:goal", "job_1:docs"]);
  });

  it("fails a job for a person with no key when the deployment has no fixed model, naming the person", async () => {
    const routed = createRoutedModel({ fixed: null, resolve: async () => null });
    await expect(routed.open(job("job_1", "person_z")).turn(GOAL)).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    await expect(routed.open(job("job_1", "person_z")).turn(GOAL)).rejects.toThrow(/person_z/);
  });

  it("prefers the person's own adapter over the fixed one when both exist", async () => {
    const own = recording("own");
    const fixed = recording("fixed");
    const routed = createRoutedModel({ fixed, resolve: async () => own });
    await routed.open(job("job_1", "person_a")).turn(GOAL);
    expect(own.opened).toHaveLength(1);
    expect(fixed.opened).toHaveLength(0);
  });
});
