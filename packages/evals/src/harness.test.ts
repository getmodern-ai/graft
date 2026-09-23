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
 * (ADR 0010), and that the proxy hands the vendor stripped paths with its own credential. The blob
 * scenario (GRA-191) runs the loop twice on one world and proves the chain end to end: a 3 MiB file
 * through the proxy into a blob, the ref into the second job's test input and the second tool's
 * input, the bytes out to the second vendor intact, and no sentinel of the file in any model turn.
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
        for (const stage of [run, ...(run.next ? [run.next] : [])]) {
          expect(stage.status.status).toBe("succeeded");
          expect(stage.status.attempts).toBe(1);
          // The settle point the scorers order asks by (GRA-63): the job's result trace is at or
          // before it and every ask the tool's use created is after it, whatever the clock said.
          const result = stage.traces.find((trace) => trace.kind === "result");
          expect(result && world.record.positionOf(result.id)).toBeLessThanOrEqual(stage.settled);
          for (const ask of stage.asks) expect(ask.position).toBeGreaterThan(stage.settled);
        }
        if (scenario.chain) {
          // The chain ran on the ref the first tool answered, and the second job's dry run read
          // that blob rather than a fixture: the harness handed a live ref, as the rule says to.
          expect(run.handoff).toMatch(/^blob:\/\/[0-9a-f-]{36}$/);
          expect(run.next).not.toBeNull();
          expect(run.next?.traces.map((trace) => trace.text)).toContain(
            "The test input names 1 live blob(s); the dry run reads it.",
          );
        }
      } finally {
        await world.close();
      }
    });
  }
});
