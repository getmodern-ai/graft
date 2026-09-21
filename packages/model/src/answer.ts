import { z } from "zod";

import {
  ANSWERS_FOR,
  answerAllowed,
  type ModelAnswer,
  type ModelSituationKind,
  type ModuleDraft,
} from "./types";

/**
 * The answer as it crosses the wire to and from a provider, and the reading of it into a
 * `ModelAnswer` the job can act on. One flat object rather than the union `types.ts` declares,
 * because that is what structured output can hold: a provider's strict JSON-schema mode wants every
 * property present and no free-form objects, so the four kinds share one shape with the fields the
 * other kinds leave empty, and the two values that *are* free-form — the input schema and the test
 * input — travel as JSON text the reader parses. What the model cannot get wrong is the shape; what
 * it can still get wrong — an answer the situation does not admit, a name that is not kebab-case, a
 * schema that is not an object — is reported as a list of sentences the adapter puts back to the
 * model for one repair turn (`./provider.ts`) before the job counts it as a model failure.
 */

export const WIRE_DRAFT_SCHEMA = z.strictObject({
  name: z.string().describe("The tool's name, kebab-case: create-order, list-items."),
  description: z.string().describe("What the tool does, for the person, in plain language."),
  inputSchemaJson: z
    .string()
    .describe(
      'A JSON Schema object for the input, as JSON text: {"type":"object","properties":{…},"required":[…]}.',
    ),
  files: z
    .array(z.strictObject({ path: z.string(), content: z.string() }))
    .describe(
      "The module's files: index.ts always; helpers beside it; package.json when a package is declared.",
    ),
  testInputJson: z
    .string()
    .describe("An input the dry run calls the tool with, valid against the schema, as JSON text."),
  proofReads: z
    .array(z.string())
    .describe(
      "Vendor-relative GET paths that prove the credential and the request shape before publishing, one per distinct path the module reads, at most five: /items?limit=1. Empty to skip.",
    ),
});

/**
 * How many proof reads one draft may ask for. The job runs every one it accepts (`acquire/job.ts`
 * in `@graft/mcp` reads this), the protocol names the number, and a draft over it is a problem the
 * model repairs — never a list silently cut short of the paths it asked to prove (Greptile on
 * graft #114).
 */
export const MAX_PROOF_READS = 5;

export const WIRE_ANSWER_SCHEMA = z.strictObject({
  kind: z.enum(["read_docs", "write_module", "proceed", "give_up"]),
  note: z
    .string()
    .describe(
      "One line the agent relays: what you learned and what you changed. For give_up, why the tool cannot be built.",
    ),
  urls: z.array(z.string()).describe("For read_docs, the pages to read. Empty otherwise."),
  draft: WIRE_DRAFT_SCHEMA.nullable().describe("For write_module, the module. Null otherwise."),
});

export type WireAnswer = z.infer<typeof WIRE_ANSWER_SCHEMA>;
export type WireDraft = z.infer<typeof WIRE_DRAFT_SCHEMA>;

/**
 * What the publish refuses a description over (`@graft/core`'s `TOOL_DESCRIPTION_MAX_LENGTH`).
 * Spelled here because this package imports nothing of Graft's; `answer.test.ts` says so, and a
 * change there is a change here.
 */
export const TOOL_DESCRIPTION_MAX_LENGTH = 500;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MODULE_ENTRIES = ["index.ts", "index.mjs"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What the publish would refuse a draft for, checked before anything is written so the model
 * learns it in a repair turn rather than as a `publish_refused` situation that costs an attempt.
 * The conformance suite asserts a backing's drafts against the same list.
 */
export function draftProblems(draft: ModuleDraft): string[] {
  const problems: string[] = [];
  if (!KEBAB.test(draft.name)) problems.push(`name "${draft.name}" is not kebab-case`);
  if (draft.description.trim().length === 0) problems.push("description is empty");
  if (draft.description.length > TOOL_DESCRIPTION_MAX_LENGTH) {
    problems.push(`description is longer than ${TOOL_DESCRIPTION_MAX_LENGTH} characters`);
  }
  if (!isRecord(draft.inputSchema) || draft.inputSchema.type !== "object") {
    problems.push('inputSchema is not a JSON Schema object with type "object"');
  }
  if (!draft.files.some((file) => MODULE_ENTRIES.includes(file.path))) {
    problems.push("files carry no index.ts (or index.mjs) entry");
  }
  for (const file of draft.files) {
    if (file.path.startsWith("/") || file.path.split("/").some((s) => s === "" || s === "..")) {
      problems.push(`file path "${file.path}" is not a plain relative path`);
    }
  }
  if (!isRecord(draft.testInput)) problems.push("testInput is not an object");
  for (const path of draft.proofReads) {
    if (!path.startsWith("/")) problems.push(`proof read "${path}" is not a vendor-relative path`);
  }
  if (draft.proofReads.length > MAX_PROOF_READS) {
    problems.push(
      `proofReads names ${draft.proofReads.length} paths and the job runs at most ${MAX_PROOF_READS}; keep the ones whose answers the module parses`,
    );
  }
  return problems;
}

export type ReadAnswer = { ok: true; answer: ModelAnswer } | { ok: false; problems: string[] };

function parseJsonObject(text: string, what: string, problems: string[]): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push(`${what} is not valid JSON`);
    return {};
  }
  if (!isRecord(parsed)) {
    problems.push(`${what} is not a JSON object`);
    return {};
  }
  return parsed;
}

/**
 * A wire answer into the job's `ModelAnswer`, or the sentences saying why it cannot be one. The
 * situation decides which kinds are admitted (`ANSWERS_FOR`); a draft is checked as the publish
 * would check it, plus the two JSON texts parsed.
 */
export function readWireAnswer(wire: WireAnswer, situation: ModelSituationKind): ReadAnswer {
  const problems: string[] = [];
  if (!answerAllowed(situation, wire.kind)) {
    problems.push(
      `"${wire.kind}" does not answer a "${situation}" situation; answer with one of ${ANSWERS_FOR[situation].join(", ")}`,
    );
    return { ok: false, problems };
  }
  switch (wire.kind) {
    case "read_docs": {
      const urls = wire.urls.map((url) => url.trim()).filter((url) => url.length > 0);
      if (urls.length === 0) problems.push("read_docs names no URL to read");
      for (const url of urls) {
        if (!isHttpUrl(url)) problems.push(`"${url}" is not an http(s) URL`);
      }
      if (wire.note.trim().length === 0) problems.push("note is empty");
      return problems.length > 0
        ? { ok: false, problems }
        : { ok: true, answer: { kind: "read_docs", urls, note: wire.note.trim() } };
    }
    case "write_module": {
      if (!wire.draft) return { ok: false, problems: ["write_module carries no draft"] };
      if (wire.note.trim().length === 0) problems.push("note is empty");
      const draft: ModuleDraft = {
        name: wire.draft.name.trim(),
        description: wire.draft.description.trim(),
        inputSchema: parseJsonObject(wire.draft.inputSchemaJson, "inputSchemaJson", problems),
        files: wire.draft.files.map((file) => ({ path: file.path.trim(), content: file.content })),
        testInput: parseJsonObject(wire.draft.testInputJson, "testInputJson", problems),
        proofReads: wire.draft.proofReads.map((path) => path.trim()).filter((p) => p.length > 0),
      };
      if (draft.files.length === 0) problems.push("the draft has no files");
      problems.push(...draftProblems(draft));
      return problems.length > 0
        ? { ok: false, problems: [...new Set(problems)] }
        : { ok: true, answer: { kind: "write_module", draft, note: wire.note.trim() } };
    }
    case "proceed": {
      if (wire.note.trim().length === 0) problems.push("note is empty");
      return problems.length > 0
        ? { ok: false, problems }
        : { ok: true, answer: { kind: "proceed", note: wire.note.trim() } };
    }
    case "give_up": {
      if (wire.note.trim().length === 0) problems.push("give_up carries no reason in note");
      return problems.length > 0
        ? { ok: false, problems }
        : { ok: true, answer: { kind: "give_up", reason: wire.note.trim() } };
    }
  }
}

/** A `ModelAnswer` back in wire form — what the conversation records as the model's own turn. */
export function wireOf(answer: ModelAnswer): WireAnswer {
  switch (answer.kind) {
    case "read_docs":
      return { kind: "read_docs", note: answer.note, urls: answer.urls, draft: null };
    case "write_module":
      return {
        kind: "write_module",
        note: answer.note,
        urls: [],
        draft: {
          name: answer.draft.name,
          description: answer.draft.description,
          inputSchemaJson: JSON.stringify(answer.draft.inputSchema),
          files: answer.draft.files,
          testInputJson: JSON.stringify(answer.draft.testInput),
          proofReads: answer.draft.proofReads,
        },
      };
    case "proceed":
      return { kind: "proceed", note: answer.note, urls: [], draft: null };
    case "give_up":
      return { kind: "give_up", note: answer.reason, urls: [], draft: null };
  }
}

/**
 * The model answered twice and neither answer could be read — what the adapter throws, and what
 * the job records as `model_failed`. Carries the tokens both turns cost so the job can still charge
 * them against the ceiling.
 */
export class ModelAnswerInvalidError extends Error {
  constructor(
    readonly problems: readonly string[],
    readonly usage: { inputTokens: number; outputTokens: number },
  ) {
    super(`The model's answer could not be read after one repair turn: ${problems.join("; ")}`);
    this.name = "ModelAnswerInvalidError";
  }
}
