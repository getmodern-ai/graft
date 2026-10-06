import {
  createScriptedModel,
  type ModelAdapter,
  type ModelJobContext,
  type ScriptedStep,
} from "@graft/model";

import { DEMO_DOCS_URL } from "./demo-vendor";
import { DROP_DOCS_URL, DROP_FOLDER, DROP_VENDOR } from "./drop-vendor";
import { FILES_DOCS_URL, FILES_VENDOR, REPORT_ID, REPORT_NAME } from "./files-vendor";
import { GITHUB_DOCS_URL, OCTOKIT_PACKAGE, OCTOKIT_VERSION } from "./github-vendor";
import type { Scenario } from "./scenarios";

/**
 * Canned answers for each scenario — what a model that followed the skill to the letter would say.
 * They drive the harness's own test (`harness.test.ts`) and `eval --scripted`, which is how the
 * scorers are shown to go green on a correct run before a provider is paid to attempt one, and how
 * a red scorer is told apart from a red model.
 *
 * A script is made per job from the job's opening context, because a chained scenario (GRA-191)
 * opens two jobs under one scenario name: the producing tool's against Files, the consuming tool's
 * against Drop, told apart by the connection's vendor. The consuming script reads the `blob://` ref
 * out of the hints the harness handed `acquire`, the way a model puts the ref it was given into the
 * draft's test input (the authoring skill's *Moving a file between tools*), so the dry run reads the
 * blob the producing tool wrote rather than a fixture.
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

/**
 * The producing half of a file move, in the authoring skill's shape: the vendor's body piped into
 * `ctx.blob.write` as a stream, typed and named from the response's headers, the ref answered under
 * `file` beside the name. Nothing of the body is read into the module.
 */
const DOWNLOAD_REPORT_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  `  const res = await ctx.fetch(\`/files/${D}{input.id}\`);`,
  `  if (!res.ok || !res.body) throw new Error(\`GET /files ${D}{res.status}: ${D}{await res.text()}\`);`,
  '  const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "file.bin";',
  "  const file = await ctx.blob.write(res.body, {",
  '    contentType: res.headers.get("content-type") ?? "application/octet-stream",',
  "    name,",
  "  });",
  "  return { file, name };",
  "};",
  "",
].join("\n");

/** The consuming half: the ref off `input.file`, the `Blob` into a `FormData`, one multipart write. */
const UPLOAD_REPORT_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  "  const file = await ctx.blob.read(input.file);",
  "  const form = new FormData();",
  `  form.append("folder", input.folder ?? "${DROP_FOLDER}");`,
  '  form.append("file", file, input.name ?? "upload.bin");',
  '  const res = await ctx.fetch("/uploads", { method: "POST", body: form });',
  `  if (!res.ok) throw new Error(\`POST /uploads ${D}{res.status}: ${D}{await res.text()}\`);`,
  "  return await res.json();",
  "};",
  "",
].join("\n");

const BLOB_REF = /blob:\/\/[0-9a-f-]{36}/;

const downloadReport: ScriptedStep[] = [
  {
    on: "goal",
    answer: { kind: "read_docs", urls: [FILES_DOCS_URL], note: "Reading the Files reference." },
  },
  {
    on: "docs",
    answer: {
      kind: "write_module",
      note: "Drafted download-report: GET /files/{id} streamed into ctx.blob.write, the ref answered; proving the credential with the list.",
      draft: {
        name: "download-report",
        description: "Downloads a file from Files by its id and answers it as a blob ref.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        files: [{ path: "index.ts", content: DOWNLOAD_REPORT_MODULE }],
        testInput: { id: REPORT_ID },
        proofReads: [{ path: "/files" }],
      },
    },
  },
  { on: "proof", answer: { kind: "proceed", note: "The list names the report; publishing." } },
];

/** The consuming script, the ref from the hints in the test input when the hints carry one. */
const uploadReport = (ref: string | null): ScriptedStep[] => [
  {
    on: "goal",
    answer: { kind: "read_docs", urls: [DROP_DOCS_URL], note: "Reading the Drop reference." },
  },
  {
    on: "docs",
    answer: {
      kind: "write_module",
      note: ref
        ? "Drafted upload-report around POST /uploads with the blob in a FormData; the test input names the ref I was given."
        : "Drafted upload-report around POST /uploads with the blob in a FormData; no ref to hand, so the test input names none.",
      draft: {
        name: "upload-report",
        description: "Uploads a file held as a blob into a Drop folder.",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: "The blob:// ref of the file to upload." },
            name: { type: "string" },
            folder: { type: "string" },
          },
          required: ["file"],
          additionalProperties: false,
        },
        files: [{ path: "index.ts", content: UPLOAD_REPORT_MODULE }],
        testInput: {
          ...(ref ? { file: ref } : {}),
          name: REPORT_NAME,
          folder: DROP_FOLDER,
        },
        proofReads: [{ path: "/folders" }],
      },
    },
  },
  {
    on: "proof",
    answer: { kind: "proceed", note: "The folder exists; publishing and dry-running the upload." },
  },
];

const scripts: Record<string, (context: ModelJobContext) => ScriptedStep[]> = {
  "read: list the items in Demo Orders": () => [
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
          proofReads: [{ path: "/items?limit=1" }],
        },
      },
    },
    { on: "proof", answer: { kind: "proceed", note: "The read answered as documented." } },
  ],
  "write: create an order in Demo Orders": () => [
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
          proofReads: [{ path: "/items/itm_1" }],
        },
      },
    },
    {
      on: "proof",
      answer: { kind: "proceed", note: "The item exists; publishing and dry-running the write." },
    },
  ],
  "sdk: list a repository's open issues through @octokit/rest": () => [
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
          proofReads: [{ path: "/repos/getmodern-ai/graft/issues?per_page=1" }],
        },
      },
    },
    { on: "proof", answer: { kind: "proceed", note: "The read answered; publishing." } },
  ],
  "blob: move a report from Files to Drop through a blob": (context) => {
    if (context.connection.vendor === FILES_VENDOR) return downloadReport;
    if (context.connection.vendor === DROP_VENDOR) {
      return uploadReport(BLOB_REF.exec(context.hints ?? context.goal)?.[0] ?? null);
    }
    throw new Error(`no scripted answers for a job against ${context.connection.vendor}`);
  },
};

export const SCRIPTED_EVALS_NAME = "scripted-evals";

/**
 * The scripted model for one scenario: each job it opens plays the script the scenario's function
 * makes from that job's context, from the start. Throws for a scenario with no script.
 */
export function scriptedModelFor(scenario: Scenario): ModelAdapter {
  const script = scripts[scenario.name];
  if (!script) throw new Error(`no scripted answers for "${scenario.name}"`);
  return {
    name: SCRIPTED_EVALS_NAME,
    open: (context) =>
      createScriptedModel(script(context), { name: SCRIPTED_EVALS_NAME }).open(context),
  };
}
