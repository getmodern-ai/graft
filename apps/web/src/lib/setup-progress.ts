/**
 * The building step's teaching (GRA-207; GRA-202, *Building and result*): every progress line an
 * `acquire` job writes, keyed to the stage of the loop it was written in, and one sentence per
 * stage saying what that stage is for. The loop is taught once: a stage's sentence rides beside the
 * first line of that stage and not again, so a job with three attempts does not say the same thing
 * three times.
 *
 * The lines are `@graft/mcp`'s (`acquire/job.ts`'s `progress` and `step` calls, and Setup's own
 * first line in `apps/server/src/setup-build.ts`). A line written while an attempt is open carries
 * `Attempt N: `; the rest of the line is what is matched. A line nothing here recognises, a
 * resumed job's or the opening "Authoring …" say, is drawn with no sentence.
 */

export type SetupBuildStage =
  | "queued"
  | "model"
  | "docs"
  | "write"
  | "sandbox"
  | "check"
  | "prove"
  | "publish"
  | "dry_run"
  | "done";

export const SETUP_STAGE_EXPLANATION: Record<SetupBuildStage, string> = {
  queued: "The job waits for a free runner. Graft runs a few jobs at once.",
  model: "Graft's model decides the next step. This is usually the longest wait.",
  docs: "Graft's model reads the vendor's own documentation before it writes anything.",
  write: "The model writes the smallest module that makes the call.",
  sandbox:
    "The module runs in this agent's own sandbox, which reaches the vendor only through Graft's proxy.",
  check: "A check reads the module before it runs and refuses anything a tool may not do.",
  prove: "Proof reads call the vendor for real, read only, to confirm it answers as documented.",
  publish: "The module is saved as a version that stays inactive until its dry run passes.",
  dry_run:
    "The dry run runs the tool once with a test input. Reads reach the vendor, and a write is only previewed.",
  done: "The tool passed and is promoted into the agent's working set.",
};

const ATTEMPT_PREFIX = /^Attempt \d+: /;

/**
 * The rules in order, each over the line less its attempt prefix; the first that matches names the
 * stage. The done rule sits before the dry run's, since both begin "the dry run".
 */
const RULES: ReadonlyArray<readonly [RegExp, SetupBuildStage]> = [
  [/^Queued: /, "queued"],
  [/^asking the model /i, "model"],
  [/^reading the documentation/i, "docs"],
  [/^opening the sandbox/i, "sandbox"],
  [/^checking the module/i, "check"],
  [/^the check refused/, "check"],
  [/^proof read \d+ of \d+/, "prove"],
  [/^\d+ (of \d+ |more )?proof read\(s\)/, "prove"],
  [/, so the draft is not published;/, "prove"],
  [/^publishing /, "publish"],
  [/^the publish refused/, "publish"],
  [/^the dry run passed/, "done"],
  [/^published .*; dry-running it/, "dry_run"],
  [/^the dry run of /, "dry_run"],
  [/in the dry run's input alone/, "dry_run"],
  [/^the module reads a blob, but the test input names no blob/, "dry_run"],
];

/** The stage a progress line was written in, or null for one nothing here recognises. */
export function progressStage(line: string): SetupBuildStage | null {
  const attempt = ATTEMPT_PREFIX.test(line);
  const rest = line.replace(ATTEMPT_PREFIX, "");
  for (const [pattern, stage] of RULES) {
    if (pattern.test(rest)) return stage;
  }
  // Inside an attempt, a line no rule names is the model's own note on the draft it just wrote.
  return attempt ? "write" : null;
}

export type ExplainedProgressLine = {
  line: string;
  stage: SetupBuildStage | null;
  /** The stage's sentence on its first line, and null on every later one. */
  explanation: string | null;
};

/**
 * Where a job stands for the building step: still working (the lines and *Continue while it
 * runs*), passed (the state read moves the record on), or failed with the job's own sentence
 * and *Change the goal*. `result` is `acquire_status`'s, whose failure carries `message`.
 */
export type BuildingView =
  | { kind: "working" }
  | { kind: "passed" }
  | { kind: "failed"; message: string };

export function buildingView(job: { status: string; result?: unknown } | undefined): BuildingView {
  if (job?.status === "succeeded") return { kind: "passed" };
  if (job?.status !== "failed") return { kind: "working" };
  const result = job.result;
  const message =
    typeof result === "object" && result !== null && "message" in result
      ? String(result.message)
      : "The job failed.";
  return { kind: "failed", message };
}

/** Every line with its stage, and each stage's sentence on the first line of it. */
export function explainProgress(lines: readonly string[]): ExplainedProgressLine[] {
  const taught = new Set<SetupBuildStage>();
  return lines.map((line) => {
    const stage = progressStage(line);
    if (!stage || taught.has(stage)) return { line, stage, explanation: null };
    taught.add(stage);
    return { line, stage, explanation: SETUP_STAGE_EXPLANATION[stage] };
  });
}

/**
 * The progress card's plain label per stage (GRA-215, *The building step is a progress card*): the
 * words a chat product puts on a tool call, one per part of the loop a person can picture. The
 * sandbox opening has none of its own and keeps the label before it.
 */
export const SETUP_STAGE_LABEL: Record<Exclude<SetupBuildStage, "sandbox">, string> = {
  queued: "Waiting to start",
  docs: "Reading the documentation",
  model: "Writing the tool",
  write: "Writing the tool",
  check: "Checking it",
  prove: "Trying it against the real service",
  publish: "Publishing",
  dry_run: "Dry run",
  done: "The tool is ready",
};

/** What the card says once a runner has picked the job up and before any stage has a line. */
export const SETUP_STARTING_LABEL = "Starting";

/** What the card says when the job ended short of a tool. */
export const SETUP_FAILED_LABEL = "The tool did not pass";

/**
 * The building step's card, from the job as `acquire_status` answers it (GRA-215): where the job
 * stands, the label of the stage it is in, one line under it that changes with each progress line
 * (the newest, its `Attempt N: ` prefix left to the attempt count), the attempt count once past
 * the first, and every line with its teaching for the *Details* disclosure. A failure's line is the
 * job's own sentence, the reason the person reads before changing the task.
 */
export type ProgressCard = {
  kind: BuildingView["kind"];
  label: string;
  message: string | null;
  /** The attempt the job is on, only once past the first. */
  attempt: number | null;
  lines: ExplainedProgressLine[];
};

function sentenceCase(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function progressCard(
  job:
    | { status: string; progress?: readonly string[]; attempts?: number; result?: unknown }
    | undefined,
): ProgressCard {
  const view = buildingView(job);
  const lines = explainProgress(job?.progress ?? []);
  let label = SETUP_STAGE_LABEL.queued;
  for (const entry of lines) {
    if (entry.stage && entry.stage !== "sandbox") label = SETUP_STAGE_LABEL[entry.stage];
    // The runner's opening line ("Authoring …", "Resumed …") says the job has left the queue.
    else if (!entry.stage && label === SETUP_STAGE_LABEL.queued) label = SETUP_STARTING_LABEL;
  }
  const newest = lines.at(-1)?.line;
  const attempts = job?.attempts ?? 0;
  return {
    kind: view.kind,
    label:
      view.kind === "failed"
        ? SETUP_FAILED_LABEL
        : view.kind === "passed"
          ? SETUP_STAGE_LABEL.done
          : label,
    message:
      view.kind === "failed"
        ? view.message
        : newest
          ? sentenceCase(newest.replace(ATTEMPT_PREFIX, ""))
          : null,
    attempt: attempts > 1 ? attempts : null,
    lines,
  };
}

/** How often the building step reads the job while it works. */
export const JOB_POLL_MS = 2_000;

/**
 * The building step's poll (`refetchInterval`): every `JOB_POLL_MS` while the job works, and not at
 * all while the read itself failed (Greptile on #170), since the step then shows *Could not read
 * the job* with its own Retry, and a failed read's missing data would otherwise read as working.
 */
export function jobPollInterval(read: {
  status: "pending" | "error" | "success";
  data: Parameters<typeof progressCard>[0];
}): number | false {
  if (read.status === "error") return false;
  return progressCard(read.data).kind === "working" ? JOB_POLL_MS : false;
}
