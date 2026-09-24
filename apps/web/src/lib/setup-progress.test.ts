import { describe, expect, it } from "vitest";

import {
  buildingView,
  explainProgress,
  progressStage,
  SETUP_STAGE_EXPLANATION,
  type SetupBuildStage,
} from "./setup-progress";

/**
 * The lines below are the shapes `@graft/mcp`'s `acquire/job.ts` writes (and Setup's first line
 * from `apps/server/src/setup-build.ts`), with a job's own values filled in.
 */
const LINES: ReadonlyArray<readonly [string, SetupBuildStage | null]> = [
  [
    "Queued: Graft's model will read the vendor's documentation, write a small module, check it, prove it with reads, publish it and dry-run it.",
    "queued",
  ],
  [
    'Authoring "Read the current weather. Read only." against Open-Meteo (open-meteo). Reads reach the vendor for real; every write is previewed at the proxy and nothing changes there.',
    null,
  ],
  ["Resumed after an interruption: 1 of 4 attempts used, 600 tokens spent.", null],
  ["Asking the model for a first draft, or the documentation to read first.", "model"],
  ["Reading the documentation: The forecast page names the current fields.", "docs"],
  ["Asking the model what to make of the pages.", "model"],
  ["Attempt 1: Drafted current-weather around GET /forecast.", "write"],
  ["Attempt 1: checking the module.", "check"],
  ["Attempt 1: the check refused the module (global-fetch); asking the model to fix it.", "check"],
  ["Attempt 1: asking the model to fix what the check refused.", "model"],
  ["Attempt 1: opening the sandbox.", "sandbox"],
  ["Attempt 1: proof read 1 of 2: GET /forecast?latitude=1&longitude=2.", "prove"],
  ["Attempt 1: 2 proof read(s) answered as the documentation said.", "prove"],
  ["Attempt 1: 1 of 2 proof read(s) failed; asking the model what to change.", "prove"],
  ["Attempt 1: 1 more proof read(s) — Checking the hourly field too.", "prove"],
  [
    "Attempt 1: a proof read failed, so the draft is not published; asking the model what to change.",
    "prove",
  ],
  ["Attempt 1: publishing open-meteo__current-weather.", "publish"],
  [
    "Attempt 1: the publish refused open-meteo__current-weather (draft-missing); asking the model to fix it.",
    "publish",
  ],
  [
    "Attempt 1: published open-meteo__current-weather v1; dry-running it with the test input.",
    "dry_run",
  ],
  [
    "Attempt 1: the dry run of open-meteo__current-weather did not run (sandbox_unavailable: down); asking the model what to change.",
    "dry_run",
  ],
  [
    "Attempt 1: the dry run of open-meteo__current-weather v1 failed; asking the model to diagnose and fix it.",
    "dry_run",
  ],
  [
    "Attempt 2: the test input names no blob and the module reads one from input.file, so a fixture blob (312 bytes of text/plain, fixture.txt) stands in as input.file in the dry run's input alone; the test input itself is unchanged.",
    "dry_run",
  ],
  [
    "Attempt 2: the dry run passed. open-meteo__current-weather v2 runs read-only and is promoted into your working set; its first real use is yours to make.",
    "done",
  ],
];

describe("progressStage", () => {
  it.each(LINES)("keys %s", (line, stage) => {
    expect(progressStage(line)).toBe(stage);
  });
});

describe("buildingView", () => {
  it("is working until the job settles, then passed or failed with the job's sentence", () => {
    expect(buildingView(undefined)).toEqual({ kind: "working" });
    expect(buildingView({ status: "queued" })).toEqual({ kind: "working" });
    expect(buildingView({ status: "running" })).toEqual({ kind: "working" });
    expect(buildingView({ status: "succeeded", result: { tool: "a__b" } })).toEqual({
      kind: "passed",
    });
    expect(
      buildingView({
        status: "failed",
        result: { failure: "model_gave_up", message: "The model gave up: no such read." },
      }),
    ).toEqual({ kind: "failed", message: "The model gave up: no such read." });
    expect(buildingView({ status: "failed" })).toEqual({
      kind: "failed",
      message: "The job failed.",
    });
  });
});

describe("explainProgress", () => {
  it("teaches each stage once, on its first line", () => {
    const explained = explainProgress([
      "Attempt 1: Drafted current-weather around GET /forecast.",
      "Attempt 1: checking the module.",
      "Attempt 1: the dry run of open-meteo__current-weather v1 failed; asking the model to diagnose and fix it.",
      "Attempt 2: Fixed the latitude.",
      "Attempt 2: checking the module.",
      "Resumed after an interruption: 1 of 4 attempts used, 600 tokens spent.",
    ]);
    expect(explained.map((entry) => entry.explanation)).toEqual([
      SETUP_STAGE_EXPLANATION.write,
      SETUP_STAGE_EXPLANATION.check,
      SETUP_STAGE_EXPLANATION.dry_run,
      null,
      null,
      null,
    ]);
    expect(explained[3]).toMatchObject({ stage: "write" });
  });

  it("says nothing with an em dash, as console copy never does", () => {
    for (const sentence of Object.values(SETUP_STAGE_EXPLANATION)) {
      expect(sentence).not.toContain("—");
    }
  });
});
