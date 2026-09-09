import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  answerAllowed,
  type DocPage,
  isValidUsage,
  type ModelAdapter,
  type ModelAnswer,
  type ModelJobContext,
  type ModelReply,
  type ModelSituation,
  type ModuleDraft,
} from "./types";

/**
 * One suite, every backing (ADR 0002). The scripted backing runs it here; the provider-backed one
 * (GRA-31) runs it against a real model, which is what makes "the same questions, the same answers"
 * a checked claim rather than a hope. What is asserted is what the job can observe — an answer of
 * an admitted kind, a draft the publish could take, usage the ceiling can be held against — never
 * how the backing arrived at it.
 *
 * The flow is the loop's own, in its shortest form: a goal, up to three rounds of documentation,
 * a draft, the check refusing it, a second draft, a failed dry run. A backing that cannot get
 * through that cannot get through an `acquire`.
 */

export type ModelConformanceFixture = {
  adapter: ModelAdapter;
  close?: () => Promise<void>;
};

/** What the suite tells the model it is building; a vendor no model will have heard of. */
export const CONFORMANCE_CONTEXT: ModelJobContext = {
  jobId: "job_conformance",
  goal: "List the items in the Demo Orders catalogue, up to a limit.",
  hints: "GET /items?limit=<n> returns { items: [{ id, name }] }.",
  connection: {
    id: "conn_conformance",
    vendor: "demo",
    displayName: "Demo Orders",
    scheme: "api_key_header",
    primaryHost: "https://api.demo.example/v2",
    hosts: ["api.demo.example"],
  },
  skill:
    "# Authoring a tool\n\nWrite the smallest module that makes the one call through ctx.fetch with a vendor-relative path. Never name a host or hold a key.",
  budget: { maxAttempts: 3, tokenCeiling: 100_000 },
};

/** The page the suite hands back for any URL the model asks to read. */
export const CONFORMANCE_PAGE: DocPage = {
  url: "https://docs.demo.example/items",
  ok: true,
  title: "Demo Orders API — Items",
  content:
    "GET /items?limit=<n>\nReturns { items: [{ id: string, name: string }] }.\nAuthenticate with the x-demo-key header.",
  truncated: false,
};

const MAX_DOC_ROUNDS = 3;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the publish would refuse a draft for, checked here first so a backing learns it in its own suite. */
export function draftProblems(draft: ModuleDraft): string[] {
  const problems: string[] = [];
  if (!KEBAB.test(draft.name)) problems.push(`name "${draft.name}" is not kebab-case`);
  if (draft.description.trim().length === 0) problems.push("description is empty");
  if (!isRecord(draft.inputSchema) || draft.inputSchema.type !== "object") {
    problems.push('inputSchema is not a JSON Schema object with type "object"');
  }
  if (!draft.files.some((file) => file.path === "index.ts" || file.path === "index.mjs")) {
    problems.push("files carry no index.ts (or index.mjs) entry");
  }
  if (!isRecord(draft.testInput)) problems.push("testInput is not an object");
  for (const path of draft.proofReads) {
    if (!path.startsWith("/")) problems.push(`proof read "${path}" is not a vendor-relative path`);
  }
  return problems;
}

export function modelConformance(
  name: string,
  makeFixture: () => Promise<ModelConformanceFixture>,
): void {
  describe(`model adapter conformance: ${name}`, () => {
    let fixture: ModelConformanceFixture;

    beforeAll(async () => {
      fixture = await makeFixture();
    });

    afterAll(async () => {
      await fixture.close?.();
    });

    const admitted = (situation: ModelSituation, reply: ModelReply): ModelAnswer => {
      expect(isValidUsage(reply.usage), "usage is whole, non-negative tokens").toBe(true);
      expect(
        answerAllowed(situation.kind, reply.answer.kind),
        `${reply.answer.kind} answers ${situation.kind}`,
      ).toBe(true);
      return reply.answer;
    };

    /** Goal, then documentation rounds, until the model drafts. */
    const draftFromGoal = async (turn: (s: ModelSituation) => Promise<ModelReply>) => {
      let answer = admitted({ kind: "goal" }, await turn({ kind: "goal" }));
      for (let round = 0; answer.kind === "read_docs" && round < MAX_DOC_ROUNDS; round += 1) {
        expect(answer.urls.length, "a read_docs answer names at least one URL").toBeGreaterThan(0);
        const situation: ModelSituation = {
          kind: "docs",
          pages: answer.urls.map((url) => ({ ...CONFORMANCE_PAGE, url })),
        };
        answer = admitted(situation, await turn(situation));
      }
      return answer;
    };

    it("names itself", () => {
      expect(fixture.adapter.name.length).toBeGreaterThan(0);
    });

    it("drafts a module the publish could take, from the goal and at most three rounds of documentation", async () => {
      const conversation = fixture.adapter.open(CONFORMANCE_CONTEXT);
      const answer = await draftFromGoal((s) => conversation.turn(s));
      expect(answer.kind, "the model drafts rather than gives up on the conformance goal").toBe(
        "write_module",
      );
      if (answer.kind !== "write_module") return;
      expect(draftProblems(answer.draft)).toEqual([]);
      expect(answer.note.length, "the note is the progress line the agent relays").toBeGreaterThan(
        0,
      );
    });

    it("answers a refused check and a failed dry run with a new draft, or gives up — never with proceed", async () => {
      const conversation = fixture.adapter.open(CONFORMANCE_CONTEXT);
      const first = await draftFromGoal((s) => conversation.turn(s));
      expect(first.kind).toBe("write_module");

      const refused: ModelSituation = {
        kind: "check_refused",
        attempt: 1,
        refusals: [
          {
            rule: "fetch-absolute-url",
            file: "index.ts",
            line: 2,
            column: 27,
            message: "ctx.fetch takes a vendor-relative path, not an absolute URL",
            hint: 'Write ctx.fetch("/items") and let the proxy supply the host.',
          },
        ],
        advice: [],
      };
      let answer = admitted(refused, await conversation.turn(refused));
      for (let round = 0; answer.kind === "read_docs" && round < MAX_DOC_ROUNDS; round += 1) {
        const situation: ModelSituation = {
          kind: "docs",
          pages: answer.urls.map((url) => ({ ...CONFORMANCE_PAGE, url })),
        };
        answer = admitted(situation, await conversation.turn(situation));
      }
      expect(["write_module", "give_up"]).toContain(answer.kind);
      if (answer.kind !== "write_module") return;
      expect(draftProblems(answer.draft)).toEqual([]);

      const failed: ModelSituation = {
        kind: "dry_run_failed",
        attempt: 2,
        report: {
          passed: false,
          reads: [{ method: "GET", path: "/item", status: 404 }],
          writesPreviewed: [],
          writesRefused: [],
          moduleError: "GET /item 404: not found",
          moduleResult: null,
          unverified: [],
        },
        failure: null,
      };
      const after = admitted(failed, await conversation.turn(failed));
      expect(["read_docs", "write_module", "give_up"]).toContain(after.kind);
    });

    it("keeps conversations apart: a second open starts from the goal again", async () => {
      const a = fixture.adapter.open(CONFORMANCE_CONTEXT);
      const b = fixture.adapter.open({ ...CONFORMANCE_CONTEXT, jobId: "job_conformance_b" });
      const [fromA, fromB] = await Promise.all([
        a.turn({ kind: "goal" }),
        b.turn({ kind: "goal" }),
      ]);
      admitted({ kind: "goal" }, fromA);
      admitted({ kind: "goal" }, fromB);
    });
  });
}
