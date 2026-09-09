import {
  isValidUsage,
  type ModelAdapter,
  type ModelAnswer,
  type ModelConversation,
  type ModelJobContext,
  type ModelSituation,
  type ModelSituationKind,
  type ModelUsage,
  type ModuleDraft,
} from "./types";

/**
 * The scripted backing: a list of canned answers, each keyed to the situation it answers, played in
 * order. What the suite drives the whole loop with — no provider, no network, the same answer every
 * run — and what a laptop without a provider key runs the loop with by hand
 * (`GRAFT_MODEL_BACKEND=scripted`, `GRAFT_MODEL_SCRIPT=<file>`).
 *
 * Deterministic on purpose, and strict about it: a step answers exactly the kind of situation it
 * was written for, so a script written for "goal, then dry_run_failed" fails loudly if the job puts
 * a `check_refused` first, rather than answering it with a draft meant for something else. The
 * mismatch and the exhausted script are both errors the job records as a model failure; a test that
 * wants a job to end another way writes the script so that it does.
 *
 * Every `open` plays the script from the start — one conversation per job, each independent — and
 * the adapter records what each conversation was shown, so a test can assert on the situations the
 * job produced as well as on what came out the other end.
 */

export type ScriptedStep = {
  /** The situation this step answers. */
  on: ModelSituationKind;
  answer: ModelAnswer;
  /** What the answer "cost"; the adapter's default when absent. A ceiling test sets it high. */
  usage?: ModelUsage;
};

export type ScriptedConversationRecord = {
  context: ModelJobContext;
  situations: ModelSituation[];
};

export type ScriptedModel = ModelAdapter & {
  /** Every conversation opened, in order, with what it was shown. */
  readonly conversations: ScriptedConversationRecord[];
};

export const SCRIPTED_MODEL_NAME = "scripted";

/** What a step costs when the script does not say. Round figures, so a sum is easy to predict in a test. */
export const DEFAULT_SCRIPTED_USAGE: ModelUsage = { inputTokens: 500, outputTokens: 100 };

/** The script has no step left for the situation the job put. */
export class ScriptExhaustedError extends Error {
  constructor(situation: ModelSituationKind, steps: number) {
    super(
      `The scripted model has no answer left: every one of its ${steps} step(s) has been used, and the job asked about "${situation}".`,
    );
    this.name = "ScriptExhaustedError";
  }
}

/** The next step was written for another situation than the one the job put. */
export class ScriptMismatchError extends Error {
  constructor(expected: ModelSituationKind, actual: ModelSituationKind, index: number) {
    super(
      `The scripted model's step ${index + 1} answers "${expected}", but the job asked about "${actual}".`,
    );
    this.name = "ScriptMismatchError";
  }
}

export function createScriptedModel(
  script: readonly ScriptedStep[],
  options: { name?: string; defaultUsage?: ModelUsage } = {},
): ScriptedModel {
  const steps = [...script];
  const defaultUsage = options.defaultUsage ?? DEFAULT_SCRIPTED_USAGE;
  const conversations: ScriptedConversationRecord[] = [];

  return {
    name: options.name ?? SCRIPTED_MODEL_NAME,
    conversations,
    open(context): ModelConversation {
      const record: ScriptedConversationRecord = { context, situations: [] };
      conversations.push(record);
      let cursor = 0;
      return {
        async turn(situation) {
          record.situations.push(situation);
          const step = steps[cursor];
          if (!step) throw new ScriptExhaustedError(situation.kind, steps.length);
          if (step.on !== situation.kind) {
            throw new ScriptMismatchError(step.on, situation.kind, cursor);
          }
          cursor += 1;
          return { answer: step.answer, usage: step.usage ?? defaultUsage };
        },
      };
    },
  };
}

const SITUATION_KINDS: readonly ModelSituationKind[] = [
  "goal",
  "docs",
  "check_refused",
  "proof",
  "publish_refused",
  "dry_run_failed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * A script as a JSON file carries it (`GRAFT_MODEL_SCRIPT`): `{ "steps": [ { "on", "answer",
 * "usage"? } ] }`, or the bare array. Checked field by field so a typo in a hand-written script is a
 * sentence naming the step, not a job that fails halfway with a stack.
 */
export function parseScript(value: unknown): ScriptedStep[] {
  const raw = isRecord(value) && "steps" in value ? value.steps : value;
  if (!Array.isArray(raw)) {
    throw new Error('A model script is an array of steps, or { "steps": [...] }');
  }
  return raw.map((entry, index) => parseStep(entry, index));
}

function parseStep(entry: unknown, index: number): ScriptedStep {
  const at = `step ${index + 1}`;
  if (!isRecord(entry)) throw new Error(`${at} is not an object`);
  const { on, answer, usage } = entry;
  if (typeof on !== "string" || !SITUATION_KINDS.includes(on as ModelSituationKind)) {
    throw new Error(`${at}: "on" must be one of ${SITUATION_KINDS.join(", ")}`);
  }
  if (usage !== undefined && !isValidUsage(usage)) {
    throw new Error(`${at}: "usage" must be { inputTokens, outputTokens } as whole numbers`);
  }
  return {
    on: on as ModelSituationKind,
    answer: parseAnswer(answer, at),
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseAnswer(value: unknown, at: string): ModelAnswer {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(`${at}: "answer" must be an object with a "kind"`);
  }
  switch (value.kind) {
    case "read_docs": {
      if (!isStringArray(value.urls) || typeof value.note !== "string") {
        throw new Error(`${at}: a read_docs answer carries "urls" (strings) and a "note"`);
      }
      return { kind: "read_docs", urls: value.urls, note: value.note };
    }
    case "write_module": {
      if (typeof value.note !== "string") {
        throw new Error(`${at}: a write_module answer carries a "note"`);
      }
      return { kind: "write_module", draft: parseDraft(value.draft, at), note: value.note };
    }
    case "proceed": {
      if (typeof value.note !== "string") {
        throw new Error(`${at}: a proceed answer carries a "note"`);
      }
      return { kind: "proceed", note: value.note };
    }
    case "give_up": {
      if (typeof value.reason !== "string") {
        throw new Error(`${at}: a give_up answer carries a "reason"`);
      }
      return { kind: "give_up", reason: value.reason };
    }
    default:
      throw new Error(
        `${at}: answer kind "${value.kind}" is not one of read_docs, write_module, proceed, give_up`,
      );
  }
}

function parseDraft(value: unknown, at: string): ModuleDraft {
  if (!isRecord(value)) throw new Error(`${at}: a write_module answer carries a "draft" object`);
  const { name, description, inputSchema, files, testInput, proofReads } = value;
  if (typeof name !== "string" || typeof description !== "string") {
    throw new Error(`${at}: the draft needs a "name" and a "description"`);
  }
  if (!isRecord(inputSchema)) throw new Error(`${at}: the draft needs an "inputSchema" object`);
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every(
      (file) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string",
    )
  ) {
    throw new Error(`${at}: the draft needs "files", each { path, content }`);
  }
  if (testInput !== undefined && !isRecord(testInput)) {
    throw new Error(`${at}: the draft's "testInput" must be an object`);
  }
  if (proofReads !== undefined && !isStringArray(proofReads)) {
    throw new Error(`${at}: the draft's "proofReads" must be an array of paths`);
  }
  return {
    name,
    description,
    inputSchema,
    files: files.map((file) => ({ path: String(file.path), content: String(file.content) })),
    testInput: testInput ?? {},
    proofReads: proofReads ?? [],
  };
}
