import { createScriptedModel, type ModelAdapter, type ScriptedStep } from "@graft/model";

import { DEMO_DOCS_URL } from "./demo-vendor";
import { GITHUB_DOCS_URL, OCTOKIT_PACKAGE, OCTOKIT_VERSION } from "./github-vendor";
import type { Scenario } from "./scenarios";

/**
 * Canned answers for each scenario — what a model that followed the skill to the letter would say.
 * They drive the harness's own test (`harness.test.ts`) and `eval --scripted`, which is how the
 * scorers are shown to go green on a correct run before a provider is paid to attempt one, and how
 * a red scorer is told apart from a red model.
 */

/** A `$` for module source, so `${D}{x}` reads as `${x}` in the module and is not interpolated here. */
const D = "$";

const LIST_ITEMS_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  `  const res = await ctx.fetch(\`/items?limit=${D}{input.limit ?? 20}\`);`,
  `  if (!res.ok) throw new Error(\`GET /items ${D}{res.status}: ${D}{await res.text()}\`);`,
  "  return await res.json();",
  "};",
  "",
].join("\n");

const CREATE_ORDER_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  '  const res = await ctx.fetch("/orders", {',
  '    method: "POST",',
  '    headers: { "content-type": "application/json" },',
  "    body: JSON.stringify({ itemId: input.itemId, quantity: input.quantity }),",
  "  });",
  `  if (!res.ok) throw new Error(\`POST /orders ${D}{res.status}: ${D}{await res.text()}\`);`,
  "  const order = await res.json();",
  "  return { id: order.id, status: order.status };",
  "};",
  "",
].join("\n");

const OCTOKIT_MODULE = [
  `import { Octokit } from "${OCTOKIT_PACKAGE}";`,
  "",
  "export default async (input: Input, ctx: Context) => {",
  "  const octokit = new Octokit({ auth: ctx.proxyKey, baseUrl: ctx.proxyBase() });",
  "  const { data } = await octokit.rest.issues.listForRepo({",
  "    owner: input.owner,",
  "    repo: input.repo,",
  '    state: "open",',
  "    per_page: 30,",
  "  });",
  "  return data.map((issue: { number: number; title: string; html_url: string }) => ({",
  "    number: issue.number,",
  "    title: issue.title,",
  "    url: issue.html_url,",
  "  }));",
  "};",
  "",
].join("\n");

const OCTOKIT_MANIFEST = JSON.stringify(
  { type: "module", dependencies: { [OCTOKIT_PACKAGE]: OCTOKIT_VERSION } },
  null,
  2,
);

const steps: Record<string, ScriptedStep[]> = {
  "read: list the items in Demo Orders": [
    {
      on: "goal",
      answer: {
        kind: "read_docs",
        urls: [DEMO_DOCS_URL],
        note: "Reading the Demo Orders reference.",
      },
    },
    {
      on: "docs",
      answer: {
        kind: "write_module",
        note: "Drafted list-items around GET /items?limit; proving it with one read.",
        draft: {
          name: "list-items",
          description: "Lists the items in Demo Orders, up to a limit.",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
            additionalProperties: false,
          },
          files: [{ path: "index.ts", content: LIST_ITEMS_MODULE }],
          testInput: { limit: 2 },
          proofReads: ["/items?limit=1"],
        },
      },
    },
    { on: "proof", answer: { kind: "proceed", note: "The read answered as documented." } },
  ],
  "write: create an order in Demo Orders": [
    {
      on: "goal",
      answer: {
        kind: "read_docs",
        urls: [DEMO_DOCS_URL],
        note: "Reading the Demo Orders reference.",
      },
    },
    {
      on: "docs",
      answer: {
        kind: "write_module",
        note: "Drafted create-order around POST /orders; proving the credential with a read of the item first.",
        draft: {
          name: "create-order",
          description: "Creates an order in Demo Orders for one item and a quantity.",
          inputSchema: {
            type: "object",
            properties: { itemId: { type: "string" }, quantity: { type: "integer", minimum: 1 } },
            required: ["itemId", "quantity"],
            additionalProperties: false,
          },
          files: [{ path: "index.ts", content: CREATE_ORDER_MODULE }],
          testInput: { itemId: "itm_1", quantity: 1 },
          proofReads: ["/items/itm_1"],
        },
      },
    },
    {
      on: "proof",
      answer: { kind: "proceed", note: "The item exists; publishing and dry-running the write." },
    },
  ],
  "sdk: list a repository's open issues through @octokit/rest": [
    {
      on: "goal",
      answer: { kind: "read_docs", urls: [GITHUB_DOCS_URL], note: "Reading the issues endpoint." },
    },
    {
      on: "docs",
      answer: {
        kind: "write_module",
        note: "Drafted list-open-issues on @octokit/rest bound to ctx.proxyKey and ctx.proxyBase; proving with one read.",
        draft: {
          name: "list-open-issues",
          description: "Lists the open issues of a GitHub repository.",
          inputSchema: {
            type: "object",
            properties: { owner: { type: "string" }, repo: { type: "string" } },
            required: ["owner", "repo"],
            additionalProperties: false,
          },
          files: [
            { path: "index.ts", content: OCTOKIT_MODULE },
            { path: "package.json", content: OCTOKIT_MANIFEST },
          ],
          testInput: { owner: "getmodern-ai", repo: "graft" },
          proofReads: ["/repos/getmodern-ai/graft/issues?per_page=1"],
        },
      },
    },
    { on: "proof", answer: { kind: "proceed", note: "The read answered; publishing." } },
  ],
};

/** The scripted model for one scenario; throws for a scenario with no script. */
export function scriptedModelFor(scenario: Scenario): ModelAdapter {
  const script = steps[scenario.name];
  if (!script) throw new Error(`no scripted answers for "${scenario.name}"`);
  return createScriptedModel(script, { name: "scripted-evals" });
}
