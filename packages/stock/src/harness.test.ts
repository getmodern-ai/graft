import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  jsonTextNotes,
  proveCheck,
  proveOptionalDefaults,
  proveReplay,
  proveTestInput,
  readStockRecording,
} from "./harness";
import { stockHarnessModeFrom } from "./mode";
import {
  formatRecording,
  type RecordedRead,
  type RecordedWrite,
  type StockRecording,
} from "./recording";
import { readStockWorkspace, type StockWorkspaceTool } from "./workspace";

/**
 * The stock harness over every tool in the workspace (ADR 0025; GRA-240), in `pnpm run test` and so
 * in CI's `Typecheck, Lint & Test`: the check and the manifest's annotations, the schema and the test
 * input, and the replay of the recording through the real proxy. Each proof answers sentences naming
 * the tool and the cause, and the assertion is that there are none, so a red run prints them.
 *
 * `GRAFT_STOCK_LIVE=1` (`pnpm --filter @graft/stock test:live`) turns the replay live (`mode.ts`);
 * the second half of the file proves the harness itself over fixture tools and runs in replay only.
 */

const mode = stockHarnessModeFrom(process.env);
if ("error" in mode) throw new Error(mode.error);

const tools = (await readStockWorkspace()).filter(
  (tool) => mode.tools === null || mode.tools.includes(`${tool.vendor}__${tool.name}`),
);

describe(`every stock tool (${mode.kind})`, () => {
  it("is at least one tool", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  describe.each(tools.map((tool) => [`${tool.vendor}__${tool.name}`, tool] as const))(
    "%s",
    (_wire, tool) => {
      it("passes the check, with the annotations its manifest declares", async () => {
        expect(await proveCheck(tool)).toEqual([]);
      });

      it("takes its test input", () => {
        expect(proveTestInput(tool)).toEqual([]);
      });

      it("requires no input it defaults or falls back on", () => {
        expect(proveOptionalDefaults(tool)).toEqual([]);
      });

      it("replays its recording: the recorded reads, writes stopped at the preview, the recorded result", async () => {
        const read = await readStockRecording(tool);
        expect(read.ok ? [] : [read.problem]).toEqual([]);
        if (!read.ok) return;
        // A note is printed, not failed on: the module may read the text for a reason of its own.
        for (const note of jsonTextNotes(tool, read.recording)) console.warn(note);
        const report = await proveReplay(tool, read.recording, mode);
        expect(report.problems).toEqual([]);
        // Only reads reached the vendor: a GET or HEAD, or a POST the recording holds as a read
        // because the proxy's classifier calls it one (GRA-260).
        const readMethods = new Set(
          read.recording.exchanges.filter((e) => e.kind === "read").map((e) => e.method),
        );
        expect(
          report.reachedVendor.every(
            (call) => ["GET", "HEAD"].includes(call.method) || readMethods.has(call.method),
          ),
        ).toBe(true);
      });
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The harness itself, over fixture tools. Never live: these vendors are the recordings alone.

const HOST = "api.example.com";

const READ_MODULE = `export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch(\`/v1/items?q=\${encodeURIComponent(input.q)}\`, { host: "${HOST}" });
  if (!res.ok) throw new Error(\`GET /v1/items \${res.status}\`);
  const body = (await res.json()) as { items: { id: string }[] };
  return { ids: body.items.map((item) => item.id) };
};
`;

const WRITE_MODULE = `export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch("/v1/notes", {
    host: "${HOST}",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: input.text }),
  });
  if (!res.ok) throw new Error(\`POST /v1/notes \${res.status}\`);
  return { status: res.status };
};
`;

const SCHEMA = (field: string) => ({
  type: "object",
  properties: { [field]: { type: "string" } },
  required: [field],
  additionalProperties: false,
});

function fixture(overrides: Partial<StockWorkspaceTool> & { module: string }): StockWorkspaceTool {
  const { module, ...rest } = overrides;
  return {
    vendor: "demo",
    name: "list-items",
    description: "Lists items.",
    inputSchema: SCHEMA("q"),
    hosts: [HOST],
    annotations: { readOnly: true, destructive: false },
    files: [{ path: "index.ts", content: module }],
    testInput: { q: "red" },
    sourceHash: "0".repeat(64),
    ...rest,
  };
}

const readTool = fixture({ module: READ_MODULE });

const readRecording: StockRecording = {
  format: 1,
  tool: "demo__list-items",
  recordedAt: "2026-10-09T00:00:00Z",
  input: { q: "red" },
  exchanges: [
    {
      kind: "read",
      method: "GET",
      url: `https://${HOST}/v1/items?q=red`,
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { json: { items: [{ id: "itm_1" }, { id: "itm_2" }] } },
      },
    },
  ],
  result: { ids: ["itm_1", "itm_2"] },
};

const firstRead = readRecording.exchanges[0] as RecordedRead;

const writeTool = fixture({
  name: "add-note",
  module: WRITE_MODULE,
  inputSchema: SCHEMA("text"),
  testInput: { text: "hello" },
  annotations: { readOnly: false, destructive: false },
});

const writeRecording: StockRecording = {
  format: 1,
  tool: "demo__add-note",
  recordedAt: "2026-10-09T00:00:00Z",
  input: { text: "hello" },
  exchanges: [
    {
      kind: "write",
      method: "POST",
      url: `https://${HOST}/v1/notes`,
      body: { json: { text: "hello" } },
    },
  ],
  // The module's own code ran on against the preview: the proxy's 202, never a vendor's answer.
  result: { status: 202 },
};

const firstWrite = writeRecording.exchanges[0] as RecordedWrite;

// A search the reviewed read table admits (`@graft/proxy`'s `read-endpoints.ts`; GRA-260): a POST
// that reaches the vendor in a dry run, recorded as a read with the body the module sent.
const SEARCH_HOST = "api.apollo.io";

const SEARCH_MODULE = `export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch("/api/v1/contacts/search", {
    host: "${SEARCH_HOST}",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q_keywords: input.q, per_page: 2 }),
  });
  if (!res.ok) throw new Error(\`POST /api/v1/contacts/search \${res.status}\`);
  const body = (await res.json()) as { contacts: { id: string }[] };
  return { ids: body.contacts.map((contact) => contact.id) };
};
`;

const searchTool = fixture({
  name: "search-contacts",
  module: SEARCH_MODULE,
  hosts: [SEARCH_HOST],
});

const searchRecording: StockRecording = {
  format: 1,
  tool: "demo__search-contacts",
  recordedAt: "2026-10-11T00:00:00Z",
  input: { q: "red" },
  exchanges: [
    {
      kind: "read",
      method: "POST",
      url: `https://${SEARCH_HOST}/api/v1/contacts/search`,
      body: { json: { q_keywords: "red", per_page: 2 } },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { json: { contacts: [{ id: "c_1" }] } },
      },
    },
  ],
  result: { ids: ["c_1"] },
};

describe("the harness over a read POST (GRA-270)", () => {
  it("answers a search the reviewed table admits from the recording, body and all", async () => {
    const report = await proveReplay(searchTool, searchRecording);
    expect(report.problems).toEqual([]);
    expect(report.reachedVendor).toEqual([
      { method: "POST", url: `https://${SEARCH_HOST}/api/v1/contacts/search` },
    ]);
    expect(report.previewed).toEqual([]);
  });

  it("fails a search whose body disagrees with the recording", async () => {
    const [read] = searchRecording.exchanges as RecordedRead[];
    const report = await proveReplay(searchTool, {
      ...searchRecording,
      exchanges: [
        { ...(read as RecordedRead), body: { json: { q_keywords: "blue", per_page: 2 } } },
      ],
    });
    expect(report.problems[0]).toBe(
      `stock tool demo__search-contacts: its read 1 disagrees with the recording: it made POST ${SEARCH_HOST}/api/v1/contacts/search, the recording holds POST ${SEARCH_HOST}/api/v1/contacts/search`,
    );
  });
});

describe("the harness over required inputs", () => {
  it("passes a tool whose required inputs it cannot do without", () => {
    expect(proveOptionalDefaults(readTool)).toEqual([]);
  });

  it("fails a required input with a default, as gmail__search-messages had", () => {
    const tool = fixture({
      module: READ_MODULE,
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", default: "in:inbox" } },
        required: ["q"],
      },
    });
    expect(proveOptionalDefaults(tool)).toEqual([
      'stock tool demo__list-items: its input schema requires q and gives it a default of "in:inbox"; drop it from required and apply the default in the module',
    ]);
  });

  it("fails a required input the module falls back on", () => {
    for (const read of [
      'input.q ?? "red"',
      'input?.q || "red"',
      'input["q"] ?? "red"',
      '(() => input.q ?? "red")()',
    ]) {
      const tool = fixture({
        module: READ_MODULE.replace("encodeURIComponent(input.q)", `encodeURIComponent(${read})`),
      });
      expect(proveOptionalDefaults(tool)).toEqual([
        "stock tool demo__list-items: its input schema requires q, but the module falls back when it is absent; drop it from required, and declare the fallback as its default",
      ]);
    }
    const assigned = fixture({
      module: READ_MODULE.replace(
        "export default async (input: Input, ctx: Context) => {",
        'export default async (input: Input, ctx: Context) => {\n  const q = input.q ?? "red";',
      ),
    });
    expect(proveOptionalDefaults(assigned)).toHaveLength(1);
  });

  it("does not read a comparison as a fallback", () => {
    for (const read of [
      'id === input.q || "red"',
      'id !== input.q || "red"',
      'n > input.q || "red"',
    ]) {
      const tool = fixture({
        module: READ_MODULE.replace(
          "encodeURIComponent(input.q)",
          `encodeURIComponent(String((id: string, n: string) => ${read}))`,
        ),
      });
      expect(proveOptionalDefaults(tool)).toEqual([]);
    }
  });

  it("does not read an || evaluated as a test as a fallback (Greptile on #216)", () => {
    const top = "export default async (input: Input, ctx: Context) => {";
    for (const extra of [
      "  if (input.q || input.other) void 0;",
      '  if ((input.q || "") && ctx) void 0;',
      '  if (!(input.q || "red")) void 0;',
      "  while (input.q || false) break;",
      "  void (input.q || input.other ? 1 : 2);",
      "  if ((ctx && (input.q || input.other)) satisfies unknown) void 0;",
      "  if ((input.q || input.other) as unknown) void 0;",
      '  if (!(input.q || "red")!) void 0;',
    ]) {
      const tool = fixture({ module: READ_MODULE.replace(top, `${top}\n${extra}`) });
      expect(proveOptionalDefaults(tool)).toEqual([]);
    }
    for (const extra of [
      '  const v = ctx && (input.q || "red");',
      '  if (ctx && (input.q || "red") === "red") void 0;',
    ]) {
      const tool = fixture({ module: READ_MODULE.replace(top, `${top}\n${extra}`) });
      expect(proveOptionalDefaults(tool)).toHaveLength(1);
    }
  });

  it("does not read a comment, a string or a shadowing parameter as a fallback (Greptile on #216)", () => {
    const top = "export default async (input: Input, ctx: Context) => {";
    for (const extra of [
      '  // Never input.q ?? "red": q is required.',
      '  const note = "input.q ?? red";',
      '  const pick = (input: { q?: string }) => input.q ?? "red";',
      '  const pickAll = ({ input }: { input: { q?: string } }) => input.q ?? "red";',
      '  if (ctx) { const input = { q: undefined as string | undefined }; void (input.q ?? "red"); }',
      '  for (const input of [{ q: "x" }]) void (input.q || "red");',
      '  try { void 0; } catch (input) { void ((input as { q?: string }).q ?? "red"); }',
    ]) {
      const tool = fixture({ module: READ_MODULE.replace(top, `${top}\n${extra}`) });
      expect(proveOptionalDefaults(tool)).toEqual([]);
    }
  });

  it("follows every form of the default export (Greptile on #216)", () => {
    const body = READ_MODULE.replace("input.q", 'input.q ?? "red"').replace(
      "export default async (input: Input, ctx: Context) => {",
      "",
    );
    for (const module of [
      `const run = async (input: Input, ctx: Context) => {${body}\nexport { run as default };\n`,
      `const run = async (input: Input, ctx: Context) => {${body}\nexport default run;\n`,
      `export default async function run(input: Input, ctx: Context) {${body.replace(/};\n$/, "}\n")}`,
    ]) {
      expect(proveOptionalDefaults(fixture({ module }))).toHaveLength(1);
    }
  });

  it("reads a destructuring default as a fallback", () => {
    for (const module of [
      READ_MODULE.replace("(input: Input,", '({ q = "red" }: Input,').replace("input.q", "q"),
      READ_MODULE.replace(
        "export default async (input: Input, ctx: Context) => {",
        'export default async (input: Input, ctx: Context) => {\n  const { q = "red" } = input;',
      ),
    ]) {
      expect(proveOptionalDefaults(fixture({ module }))).toHaveLength(1);
    }
  });

  it("names nothing for a tool with no required list", () => {
    const tool = fixture({
      module: READ_MODULE.replace(
        "encodeURIComponent(input.q)",
        'encodeURIComponent(input.q ?? "red")',
      ),
      inputSchema: { type: "object", properties: { q: { type: "string", default: "red" } } },
    });
    expect(proveOptionalDefaults(tool)).toEqual([]);
  });
});

describe("the harness", () => {
  it("passes a read tool whose recording agrees, answering every read from the recording", async () => {
    const report = await proveReplay(readTool, readRecording);
    expect(report.problems).toEqual([]);
    expect(report.reachedVendor).toEqual([
      { method: "GET", url: `https://${HOST}/v1/items?q=red` },
    ]);
  });

  it("fails a tool whose read disagrees with the recording, naming the tool and both reads", async () => {
    const report = await proveReplay(readTool, {
      ...readRecording,
      exchanges: [{ ...firstRead, url: `https://${HOST}/v1/things?q=red` }],
    });
    expect(report.problems[0]).toBe(
      `stock tool demo__list-items: its read 1 disagrees with the recording: it made GET ${HOST}/v1/items?q=red, the recording holds GET ${HOST}/v1/things?q=red`,
    );
  });

  it("fails a tool that makes fewer reads than the recording holds", async () => {
    const extra = { ...firstRead, url: `https://${HOST}/v1/more` };
    const report = await proveReplay(readTool, {
      ...readRecording,
      exchanges: [...readRecording.exchanges, extra],
    });
    expect(report.problems).toEqual([
      `stock tool demo__list-items: it never made the recording's read 2: GET https://${HOST}/v1/more`,
    ]);
  });

  it("fails a tool whose result disagrees with the recording's", async () => {
    const report = await proveReplay(readTool, { ...readRecording, result: { ids: ["itm_1"] } });
    expect(report.problems).toEqual([
      'stock tool demo__list-items: its result disagrees with the recording\'s: it answered {"ids":["itm_1","itm_2"]}, the recording holds {"ids":["itm_1"]}',
    ]);
  });

  it("stops a write at the preview: it never reaches the vendor, and the preview is the recording's", async () => {
    const report = await proveReplay(writeTool, writeRecording);
    expect(report.problems).toEqual([]);
    expect(report.reachedVendor).toEqual([]);
    expect(report.previewed).toEqual([
      { method: "POST", host: HOST, path: "/v1/notes", body: { json: { text: "hello" } } },
    ]);
  });

  it("fails a write whose body disagrees with the recording", async () => {
    const report = await proveReplay(writeTool, {
      ...writeRecording,
      exchanges: [{ ...firstWrite, body: { json: { text: "bye" } } }],
    });
    expect(report.problems).toEqual([
      'stock tool demo__add-note: its write 1\'s body disagrees with the recording: it sent {"text":"hello"}, the recording holds {"text":"bye"}',
    ]);
  });

  it("fails a write the recording does not hold", async () => {
    const report = await proveReplay(writeTool, { ...writeRecording, exchanges: [] });
    expect(report.problems).toEqual([
      "stock tool demo__add-note: it made 1 write(s) that stopped at the preview; the recording holds 0",
    ]);
    expect(report.reachedVendor).toEqual([]);
  });

  it("fails a tool calling a host its manifest does not declare: the proxy refuses it", async () => {
    const report = await proveReplay({ ...readTool, hosts: ["other.example.com"] }, readRecording);
    expect(report.reachedVendor).toEqual([]);
    expect(report.problems).toEqual([
      expect.stringMatching(
        /^stock tool demo__list-items: it never made the recording's read 1: GET https:\/\/api\.example\.com/,
      ),
      expect.stringMatching(/^stock tool demo__list-items: its dry run did not pass: .*403/),
    ]);
  });

  it("replays a keyed starter's tool with no credential: the vendor is the recording", async () => {
    const keyed = { ...readTool, vendor: "github" };
    const report = await proveReplay(keyed, { ...readRecording, tool: "github__list-items" });
    expect(report.problems).toEqual([]);
  });

  it("fails a call to a starter's primary host the manifest does not declare", async () => {
    // GitHub's starter names api.github.com; this manifest declares api.example.com alone.
    const undeclared = fixture({
      vendor: "github",
      module: READ_MODULE.replace(`host: "${HOST}"`, 'host: "api.github.com"'),
    });
    const report = await proveReplay(undeclared, {
      ...readRecording,
      tool: "github__list-items",
      exchanges: [{ ...firstRead, url: "https://api.github.com/v1/items?q=red" }],
    });
    expect(report.reachedVendor).toEqual([]);
    expect(report.problems).toContainEqual(
      expect.stringMatching(/^stock tool github__list-items: its dry run did not pass: .*403/),
    );
  });

  it("fails a recording made with another input, or holding a credential", async () => {
    expect(
      (await proveReplay(readTool, { ...readRecording, input: { q: "blue" } })).problems,
    ).toEqual([
      "stock tool demo__list-items: its recording was made with another input than test-input.json; rebuild it",
    ]);
    const leaky: StockRecording = {
      ...readRecording,
      exchanges: [
        {
          ...firstRead,
          url: `https://${HOST}/v1/items?q=red&access_token=abcdef123456`,
        },
      ],
    };
    expect((await proveReplay(readTool, leaky)).problems).toEqual([
      "stock tool demo__list-items: its recording holds something credential-shaped that redaction would replace; write it through redactRecording",
    ]);
  });

  it("sets a redacted query parameter aside, since the scheme puts the credential there", async () => {
    const keyed: StockRecording = {
      ...readRecording,
      exchanges: [
        {
          ...firstRead,
          url: `https://${HOST}/v1/items?q=red&api_key=[redacted:credential]`,
        },
      ],
    };
    expect((await proveReplay(readTool, keyed)).problems).toEqual([]);
  });

  it("fails annotations that disagree with the manifest, naming the tool and the annotation", async () => {
    expect(
      await proveCheck({ ...writeTool, annotations: { readOnly: true, destructive: false } }),
    ).toEqual([
      "stock tool demo__add-note: its manifest declares readOnly: true, but the check derives readOnly: false from the module",
    ]);
  });

  it("fails a test input its schema refuses, naming the tool", () => {
    const [problem] = proveTestInput({ ...readTool, testInput: { city: "Melbourne" } });
    expect(problem).toMatch(
      /^stock tool demo__list-items: its test input fails its input schema: /,
    );
  });

  it("fails a tool with no recording, or a malformed one, naming the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "graft-stock-harness-"));
    await mkdir(join(root, "demo", "list-items"), { recursive: true });
    expect(await readStockRecording(readTool, root)).toEqual({
      ok: false,
      problem:
        "stock tool demo__list-items: demo/list-items/recording.json is missing; the build command writes it",
    });
    await writeFile(
      join(root, "demo", "list-items", "recording.json"),
      formatRecording({ ...readRecording, format: 2 as 1 }),
    );
    expect(await readStockRecording(readTool, root)).toEqual({
      ok: false,
      problem:
        "stock tool demo__list-items: demo/list-items/recording.json has format 2; this harness reads 1",
    });
    await writeFile(
      join(root, "demo", "list-items", "recording.json"),
      formatRecording(readRecording),
    );
    expect(await readStockRecording(readTool, root)).toEqual({
      ok: true,
      recording: readRecording,
    });
  });
});
