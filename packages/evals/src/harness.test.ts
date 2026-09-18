import { describe, expect, it } from "vitest";

import { runScenario } from "./run-scenario";
import { scenarios } from "./scenarios";
import { scriptedModelFor } from "./scripted-answers";
import { openWorld } from "./world";

/**
 * The harness's own test: every scenario under its canned answers goes green on every scorer. This
 * is what separates a red scorer from a red model — a scorer that cannot pass on a run that followed
 * the skill to the letter is a broken scorer — and it runs the real loop, the real check and the
 * real proxy the evals run, on every commit and with no key. The SDK scenario also proves that
 * `@graft/check` accepts an `@octokit/rest` client bound to `ctx.proxyKey` and `ctx.proxyBase()`
 * (ADR 0010), and that the proxy hands the vendor stripped paths with its own credential.
 */

const BOUNDS = { maxAttempts: 3, tokenCeiling: 400_000 };

describe("the evals harness under scripted answers", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const world = await openWorld({ model: scriptedModelFor(scenario), ...BOUNDS });
      try {
        const run = await runScenario(world, scenario, { pollMs: 50 });
        const scores = scenario.score(run, BOUNDS);
        const red = scores.filter((score) => !score.pass);
        expect(red, red.map((score) => `${score.name}: ${score.detail ?? ""}`).join("\n")).toEqual(
          [],
        );
        expect(run.status.status).toBe("succeeded");
        expect(run.status.attempts).toBe(1);
        // The settle point the scorers order asks by (GRA-63): the job's result trace is at or
        // before it and every ask the tool's use created is after it, whatever the clock said.
        const result = run.traces.find((trace) => trace.kind === "result");
        expect(result && world.record.positionOf(result.id)).toBeLessThanOrEqual(run.settled);
        for (const ask of run.asks) expect(ask.position).toBeGreaterThan(run.settled);
      } finally {
        await world.close();
      }
    });
  }
});
