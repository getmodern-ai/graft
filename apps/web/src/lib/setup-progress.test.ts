import { describe, expect, it } from "vitest";

import {
  buildingView,
  explainProgress,
  JOB_POLL_MS,
  jobPollInterval,
  progressCard,
  progressStage,
  SETUP_FAILED_LABEL,
  SETUP_STAGE_EXPLANATION,
  SETUP_STAGE_LABEL,
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
  // The provider's note when the goal names its own pages (`@graft/model`'s `provider.ts`, GRA-212).
  ["Reading the documentation: https://open-meteo.com/en/docs, named with the goal", "docs"],
  ["Asking the model what to make of the pages.", "model"],
  ["Attempt 1: Drafted current-weather around GET /forecast.", "write"],
  ["Attempt 1: checking the module.", "check"],
  ["Attempt 1: the check refused the module (global-fetch); asking the model to fix it.", "check"],
  ["Attempt 1: asking the model to fix what the check refused.", "model"],
  ["Attempt 1: opening the sandbox.", "sandbox"],
  ["Attempt 1: proof read 1 of 2: GET /forecast?latitude=1&longitude=2.", "prove"],
  ["Attempt 1: 2 proof read(s) answered as the documentation said.", "prove"],
  ["Attempt 1: 1 of 2 proof read(s) failed; asking the model what to change.", "prove"],
  ["Attempt 1: 1 more proof read(s): Checking the hourly field too.", "prove"],
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
  [
    "Attempt 2: the dry run passed. v2 is not current, since a later job made v3 current first, so open-meteo__current-weather runs as v3 and is already in your working set; its first real use is yours to make.",
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

/**
 * A live job's lines, as the fake sandbox and the scripted model wrote them walking Setup by hand on
 * 2026-09-24 (GRA-215): the first attempt's dry run failed on a wrong path and the script had no
 * answer for it; the second job passed.
 */
const FIRST =
  "Queued: Graft's model will read the vendor's documentation, write a small module, check it, prove it with reads, publish it and dry-run it.";
const LIVE_PASS = [
  FIRST,
  'Authoring "Tell me the weather right now in a city I name" against Open-Meteo (open-meteo). Reads reach the vendor for real; every write is previewed at the proxy and nothing changes there.',
  "Asking the model for a first draft, or the documentation to read first.",
  "Attempt 1: opening the sandbox.",
  "Attempt 1: Drafted current-weather around GET /v1/forecast.",
  "Attempt 1: checking the module.",
  "Attempt 1: publishing open-meteo__current-weather.",
  "Attempt 1: published open-meteo__current-weather v2; dry-running it with the test input.",
  "Attempt 1: the dry run passed. open-meteo__current-weather now runs as v2 and is promoted into your working set; its first real use is yours to make.",
];
const LIVE_FAIL = [
  ...LIVE_PASS.slice(0, 7),
  "Attempt 1: published open-meteo__current-weather v1; dry-running it with the test input.",
  "Attempt 1: the dry run of open-meteo__current-weather v1 failed; asking the model to diagnose and fix it.",
  "Asking the model to diagnose the failed dry run.",
  'Stopped: The model failed to answer dry_run_failed: The scripted model has no answer left: every one of its 1 step(s) has been used, and the job asked about "dry_run_failed".',
];

describe("progressCard (GRA-215)", () => {
  const upTo = (lines: readonly string[], count: number) => ({
    status: "running",
    progress: lines.slice(0, count),
    attempts: 1,
  });

  it("labels each stage plainly as the lines arrive, the newest line under it", () => {
    const labels = LIVE_PASS.slice(0, -1).map(
      (_, index) => progressCard(upTo(LIVE_PASS, index + 1)).label,
    );
    expect(labels).toEqual([
      SETUP_STAGE_LABEL.queued,
      // The runner's "Authoring …" line: the job has left the queue.
      "Starting",
      "Writing the tool",
      // The sandbox opening keeps the label before it.
      "Writing the tool",
      "Writing the tool",
      "Checking it",
      "Publishing",
      "Dry run",
    ]);
    expect(progressCard(upTo(LIVE_PASS, 6))).toMatchObject({
      kind: "working",
      message: "Checking the module.",
      attempt: null,
    });
    expect(progressCard(upTo(LIVE_PASS, 3)).message).toBe(
      "Asking the model for a first draft, or the documentation to read first.",
    );
  });

  it("names the documentation and the proof reads in the words the ticket gives", () => {
    expect(
      progressCard(
        upTo(
          [FIRST, "Reading the documentation: https://open-meteo.com/en/docs, named with the goal"],
          2,
        ),
      ).label,
    ).toBe("Reading the documentation");
    expect(
      progressCard(
        upTo([FIRST, "Attempt 1: proof read 1 of 2: GET /forecast?latitude=1&longitude=2."], 2),
      ),
    ).toMatchObject({
      label: "Trying it against the real service",
      message: "Proof read 1 of 2: GET /forecast?latitude=1&longitude=2.",
    });
  });

  it("turns into the ready label on a pass, keeping every line for Details", () => {
    const card = progressCard({ status: "succeeded", progress: LIVE_PASS, attempts: 1 });
    expect(card).toMatchObject({ kind: "passed", label: "The tool is ready", attempt: null });
    expect(card.lines.map((entry) => entry.line)).toEqual(LIVE_PASS);
  });

  it("shows the job's own reason on a failure", () => {
    const message = "The model failed to answer dry_run_failed: the script had no answer left.";
    const card = progressCard({
      status: "failed",
      progress: LIVE_FAIL,
      attempts: 1,
      result: { failure: "model_failed", message },
    });
    expect(card).toMatchObject({ kind: "failed", label: SETUP_FAILED_LABEL, message });
  });

  it("counts the attempt once past the first", () => {
    const second = [
      ...LIVE_FAIL.slice(0, 9),
      "Attempt 2: Fixed the path.",
      "Attempt 2: checking the module.",
    ];
    expect(progressCard({ status: "running", progress: second, attempts: 2 })).toMatchObject({
      attempt: 2,
      label: "Checking it",
      message: "Checking the module.",
    });
  });

  it("waits to start with no line yet, and says nothing with an em dash", () => {
    expect(progressCard(undefined)).toMatchObject({
      kind: "working",
      label: "Waiting to start",
      message: null,
    });
    for (const label of [...Object.values(SETUP_STAGE_LABEL), SETUP_FAILED_LABEL]) {
      expect(label).not.toContain("—");
    }
  });
});

describe("jobPollInterval", () => {
  it("reads the job every two seconds while it works, and before the first read lands", () => {
    expect(jobPollInterval({ status: "success", data: { status: "running" } })).toBe(JOB_POLL_MS);
    expect(jobPollInterval({ status: "pending", data: undefined })).toBe(JOB_POLL_MS);
  });

  it("stops once the job settled", () => {
    expect(
      jobPollInterval({ status: "success", data: { status: "succeeded", result: { tool: "a" } } }),
    ).toBe(false);
    expect(jobPollInterval({ status: "success", data: { status: "failed" } })).toBe(false);
  });

  it("stops while the read failed, leaving the step's Retry to read again", () => {
    expect(jobPollInterval({ status: "error", data: undefined })).toBe(false);
  });
});
