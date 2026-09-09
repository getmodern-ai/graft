/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are module source text, and a template placeholder inside a plain string is exactly what a module holds. */
import { describe, expect, it } from "vitest";

import {
  checkModule,
  dependenciesOf,
  MODULE_CHECK_MAX_BYTES,
  MODULE_CHECK_TIMEOUT_MS,
  readModuleSources,
  singleFileModule,
  UNKNOWN_ANNOTATIONS,
} from "./module-check";
import {
  ADVICE_RULES,
  BANNED_MODULES,
  CONTEXT_DECLARATION,
  checkModuleSync,
  type Diagnostic,
  inputTypeFromSchema,
  type ModuleCheckFile,
  REFUSAL_RULES,
  SDK_BASE_OPTIONS,
  SDK_CREDENTIAL_OPTIONS,
} from "./module-check.core";

/**
 * The static check. Pure: files, a schema and a dependency list in, diagnostics and annotations out.
 * Every rule is exercised against the smallest module that trips it, and the diagnostic shape — file,
 * line, column, the offending line, a hint — is what the model reads back, so it is pinned here. The
 * budget runs through `checkModule`, the worker-thread door, because that is where it lives.
 */

const SCHEMA = {
  type: "object",
  properties: {
    itemId: { type: "string" },
    quantity: { type: "integer" },
    notes: { type: "string" },
  },
  required: ["itemId", "quantity"],
};

/** A clean module that reads every declared field and returns plain data. */
const CLEAN_TS = [
  "export default async (input: Input, ctx: Context) => {",
  '  const res = await ctx.fetch("/orders", {',
  '    method: "POST",',
  '    headers: { "content-type": "application/json" },',
  "    body: JSON.stringify({ itemId: input.itemId, quantity: input.quantity, notes: input.notes }),",
  "  });",
  "  if (!res.ok) throw new Error(`POST /orders ${res.status}: ${await res.text()}`);",
  "  const order = await res.json();",
  "  return { id: order.id, status: order.status };",
  "};",
].join("\n");

const CLEAN_MJS = [
  'import { double } from "./helper.mjs";',
  "export default async (input, ctx) => {",
  '  const res = await ctx.fetch("/orders", { method: "POST", body: JSON.stringify(input) });',
  "  return { doubled: double(input.quantity), id: input.itemId, notes: input.notes, ok: res.ok };",
  "};",
].join("\n");

const HELPER_MJS = "/** @param {number} n */\nexport const double = (n) => n * 2;\n";

/** Every declared field read, so the fixtures below can vary one thing and stay advice-free. */
const READS_INPUT = "i: input.itemId, q: input.quantity, n: input.notes";

const WRITE = { readOnly: false, destructive: false };
const READ = { readOnly: true, destructive: false };
const DESTRUCTIVE = { readOnly: false, destructive: true };

function check(
  files: Record<string, string>,
  options: { entry?: string; schema?: unknown; dependencies?: string[] } = {},
) {
  const list: ModuleCheckFile[] = Object.entries(files).map(([path, content]) => ({
    path,
    content,
  }));
  const entry = options.entry ?? (files["index.ts"] !== undefined ? "index.ts" : "index.mjs");
  return checkModuleSync({
    files: list,
    entry,
    inputSchema: (options.schema === undefined ? SCHEMA : options.schema) as Record<
      string,
      unknown
    > | null,
    dependencies: options.dependencies ?? [],
  });
}

const rules = (diagnostics: Diagnostic[]) => diagnostics.map((d) => d.rule);

describe("a clean module", () => {
  it("passes in TypeScript with no refusals and no advice, annotated as a write", () => {
    const result = check({ "index.ts": CLEAN_TS });
    expect(result).toEqual({ entry: "index.ts", refusals: [], advice: [], annotations: WRITE });
  });

  it("passes in JavaScript, checked as JavaScript, with a JSDoc-typed helper beside it", () => {
    const result = check({ "index.mjs": CLEAN_MJS, "helper.mjs": HELPER_MJS });
    expect(result).toEqual({ entry: "index.mjs", refusals: [], advice: [], annotations: WRITE });
  });

  it("may use Node's globals, Node's built-ins and a catch variable without ceremony", () => {
    const result = check({
      "index.ts": [
        'import { createHash } from "node:crypto";',
        'import { basename } from "path";',
        "export default async (input: Input, ctx: Context) => {",
        "  try {",
        '    const url = new URL("https://x.example/a");',
        "    const q = new URLSearchParams({ item: input.itemId, n: String(input.quantity) });",
        '    console.log(url.hostname, basename("/a/b"), Buffer.from("a").toString("base64"), crypto.randomUUID());',
        "    await new Promise((resolve) => setTimeout(resolve, 10));",
        "    const res = await ctx.fetch(`/orders?${q}`, { signal: AbortSignal.timeout(5000) });",
        '    return { hash: createHash("sha256").update(input.notes ?? "").digest("hex"), ok: res.ok };',
        "  } catch (error) {",
        "    throw new Error(error.message);",
        "  }",
        "};",
      ].join("\n"),
    });
    expect(result.refusals).toEqual([]);
    expect(result.advice).toEqual([]);
    expect(result.annotations).toEqual(READ);
  });

  it("may read every name ctx carries, and the runner's context matches the declaration word for word", () => {
    const result = check({
      "index.ts": [
        "export default async (input: Input, ctx: Context) => {",
        "  const base: string = ctx.proxyBase();",
        '  const other: string = ctx.proxyBase("api.example.com");',
        "  const key: string = ctx.proxyKey;",
        "  const connection: string | null = ctx.connection;",
        '  const res = await ctx.fetch("/x");',
        `  return { base, other, key: key.length, connection, ok: res.ok, ${READS_INPUT} };`,
        "};",
      ].join("\n"),
    });
    expect(result.refusals).toEqual([]);
    expect(CONTEXT_DECLARATION).toBe(
      "{ fetch(path: string, init?: RequestInit): Promise<Response>; proxyBase(host?: string): string; proxyKey: string; connection: string | null }",
    );
  });
});

describe("the diagnostic shape", () => {
  it("carries the file, a 1-based line and column, the offending line, a message, a hint and a rule", () => {
    const result = check({
      "index.ts": [
        "export default async (input: Input, ctx: Context) => {",
        '  const res = await ctx.fetch("/orders", { body: JSON.stringify({ quantity: input.quanity, itemId: input.itemId, notes: input.notes }) });',
        "  return res.json();",
        "};",
      ].join("\n"),
    });

    expect(result.refusals).toEqual([
      {
        file: "index.ts",
        line: 2,
        column: 83,
        text: 'const res = await ctx.fetch("/orders", { body: JSON.stringify({ quantity: input.quanity, itemId: input.itemId, notes: input.notes }) });',
        message: "Property 'quanity' does not exist on type 'Input'. Did you mean 'quantity'?",
        hint: "Input has only the fields the schema declares — itemId, quantity, notes. Fix the field name, or add it to the schema.",
        rule: "type-error",
      },
    ]);
    expect(Object.keys(result.refusals[0] ?? {}).sort()).toEqual(
      ["column", "file", "hint", "line", "message", "rule", "text"].sort(),
    );
  });

  it("names every rule it can raise, split into refusals and advice", () => {
    expect(REFUSAL_RULES).toContain("execute-environment");
    expect(REFUSAL_RULES).toContain("sdk-not-bound");
    expect(REFUSAL_RULES).toContain("import-not-vendored");
    expect(ADVICE_RULES).toContain("implicit-any");
    expect(new Set([...REFUSAL_RULES, ...ADVICE_RULES]).size).toBe(
      REFUSAL_RULES.length + ADVICE_RULES.length,
    );
  });
});

describe("the default export", () => {
  it("is refused when missing", () => {
    const result = check({
      "index.ts": "export const run = async (input: Input, ctx: Context) => input.itemId;",
    });
    expect(rules(result.refusals)).toEqual(["default-export-missing"]);
    expect(result.refusals[0]).toMatchObject({
      line: 1,
      column: 1,
      hint: expect.stringContaining("export default async"),
    });
  });

  it("is refused when not async, and when it does not take two parameters", () => {
    const result = check({
      "index.ts":
        "export default (input: Input) => ({ a: input.itemId, q: input.quantity, n: input.notes });",
    });
    expect(rules(result.refusals)).toEqual(["default-export-arity", "default-export-not-async"]);
    expect(result.refusals[0]?.message).toContain("takes 1 parameter");
    expect(result.refusals[1]?.hint).toContain("export default async (input: Input, ctx: Context)");
  });

  it("is refused when it is not a function at all, in the contract's words", () => {
    const result = check({ "index.ts": "export default 42;" });
    expect(rules(result.refusals)).toEqual(["default-export-type"]);
    expect(result.refusals[0]?.message).toContain(
      "(input: Input, ctx: Context) => Promise<unknown>",
    );
    expect(result.refusals[0]?.message).not.toContain("__GraftTool");
  });

  it("is refused when its own annotation disagrees with Input, at the export", () => {
    const result = check({
      "index.ts": [
        "type Mine = { quanity: number };",
        "export default async (input: Mine, ctx: Context) => ({ q: input.quanity });",
      ].join("\n"),
    });
    expect(rules(result.refusals)).toEqual(["default-export-type"]);
    expect(result.refusals[0]).toMatchObject({ line: 2 });
  });
});

/** The check's reason to exist: unannotated parameters are typed from the schema all the same. */
describe("a read of a field the schema does not declare", () => {
  const TYPO = "input.quanity";

  it.each([
    [
      "an arrow",
      "export default async (input, ctx) => ({ q: input.quanity, i: input.itemId, n: input.notes });",
    ],
    [
      "a function declaration",
      "export default async function createOrder(input, ctx) {\n  return { q: input.quanity, i: input.itemId, n: input.notes };\n}",
    ],
    [
      "a const referenced by name",
      "const run = async (input, ctx) => ({ q: input.quanity, i: input.itemId, n: input.notes });\nexport default run;",
    ],
  ])("is caught in %s without an annotation, at the line that reads it", (_form, source) => {
    const result = check({ "index.ts": source });
    expect(rules(result.refusals)).toEqual(["type-error"]);
    expect(result.refusals[0]?.text).toContain(TYPO);
    expect(result.refusals[0]?.message).toContain("Did you mean 'quantity'?");
    // The other half of the same typo: the field the schema does declare is never read.
    expect(rules(result.advice)).toEqual(["unread-input-field"]);
    expect(result.advice[0]?.message).toContain("declares quantity");
  });

  it("is caught in JavaScript through a JSDoc cast", () => {
    const result = check({
      "index.mjs":
        "export default async (input, ctx) => ({ q: input.quanity, i: input.itemId, n: input.notes });",
    });
    expect(rules(result.refusals)).toEqual(["type-error"]);
    expect(result.refusals[0]?.text).toContain(TYPO);
  });

  it("is caught against a nested object and an array item, too", () => {
    const result = check(
      {
        "index.ts": [
          "export default async (input: Input, ctx: Context) => ({",
          "  first: input.lines[0]?.skuu,",
          "  city: input.address.citty,",
          "  n: input.lines.length,",
          "});",
        ].join("\n"),
      },
      {
        schema: {
          type: "object",
          properties: {
            lines: {
              type: "array",
              items: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
            },
            address: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
          required: ["lines", "address"],
        },
      },
    );
    expect(result.refusals.map((r) => [r.line, r.message])).toEqual([
      [2, "Property 'skuu' does not exist on type '{ sku: string; }'. Did you mean 'sku'?"],
      [3, "Property 'citty' does not exist on type '{ city: string; }'. Did you mean 'city'?"],
    ]);
  });

  it("falls back to advice when the function is a named declaration referenced by name", () => {
    const result = check({
      "index.ts":
        "async function run(input, ctx) { return { i: input.itemId, q: input.quantity, n: input.notes }; }\nexport default run;",
    });
    expect(result.refusals).toEqual([]);
    expect(rules(result.advice)).toEqual(["implicit-any", "implicit-any"]);
    expect(result.advice[0]?.hint).toContain("(input: Input, ctx: Context)");
  });

  it("refuses a read of anything ctx does not carry, saying what it does", () => {
    const result = check({
      "index.ts": `export default async (input: Input, ctx: Context) => ({ t: ctx.token, ${READS_INPUT} });`,
    });
    expect(rules(result.refusals)).toEqual(["type-error"]);
    expect(result.refusals[0]?.hint).toContain("fetch, proxyBase, proxyKey and connection");
    expect(result.refusals[0]?.hint).toContain(CONTEXT_DECLARATION);
  });
});

describe("syntax", () => {
  it("is refused at the line, and nothing else is said", () => {
    const result = check({
      "index.ts":
        "export default async (input: Input, ctx: Context) => {\n  const x = ;\n  return input.itemId;\n};",
    });
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "syntax",
        line: 2,
        column: 13,
        text: "const x = ;",
        message: "Expression expected.",
      }),
    ]);
    expect(result.advice).toEqual([]);
  });
});

describe("banned surface", () => {
  it("refuses a read of the exec's environment, in any file, by any spelling — but not in a comment", () => {
    const result = check({
      "index.ts": [
        'import { sign } from "./lib/sign.ts";',
        "export default async (input: Input, ctx: Context) => ({ s: sign(input.itemId), q: input.quantity, n: input.notes });",
      ].join("\n"),
      "lib/sign.ts": [
        "// GRAFT_TOKEN is never read here, says this comment",
        'export const sign = (s: string) => `${s}:${process.env.GRAFT_TOKEN ?? ""}`;',
        "const { GRAFT_CONNECTION } = process.env;",
        'export const url = `${process.env["GRAFT_PROXY_URL"]}/c/${GRAFT_CONNECTION}`;',
      ].join("\n"),
    });

    expect(result.refusals.map((r) => [r.rule, r.file, r.line])).toEqual([
      ["execute-environment", "lib/sign.ts", 2],
      ["execute-environment", "lib/sign.ts", 3],
      ["execute-environment", "lib/sign.ts", 4],
    ]);
    expect(result.refusals[0]?.message).toContain("lib/sign.ts reads GRAFT_TOKEN");
    expect(result.refusals[0]?.message).toContain("token_invalid");
    expect(result.refusals[0]?.hint).toContain("ctx.fetch");
    expect(result.refusals[2]?.message).toContain("GRAFT_PROXY_URL and GRAFT_CONNECTION");
  });

  /** The runner deletes the same prefix before the module loads; a rename on one side alone would silently stop enforcing. */
  it("does not refuse the prefix the runner no longer removes", () => {
    const result = check({
      "index.ts": `export default async (input: Input, ctx: Context) => ({ t: process.env.CANDO_TOKEN ?? null, ${READS_INPUT} });`,
    });
    expect(rules(result.refusals)).not.toContain("execute-environment");
  });

  it.each(BANNED_MODULES)(
    "refuses %s, bare, prefixed, required or imported dynamically",
    (name) => {
      const result = check({
        "index.ts": [
          `import a from "node:${name}";`,
          `import b from "${name}";`,
          `const c = require("${name}");`,
          "export default async (input: Input, ctx: Context) => {",
          `  const d = await import("node:${name}");`,
          "  return { a, b, c, d, i: input.itemId, q: input.quantity, n: input.notes };",
          "};",
        ].join("\n"),
      });
      expect(result.refusals.filter((r) => r.rule === "banned-module").map((r) => r.line)).toEqual([
        1, 2, 3, 5,
      ]);
      expect(result.refusals[0]?.message).toContain(`imports node:${name}`);
    },
  );

  it("refuses an import from outside the module, by relative path, by absolute path, or by a computed name", () => {
    const result = check({
      "index.ts": [
        'import { a } from "../shared/a.ts";',
        'import { b } from "/tools/other/b.ts";',
        "export default async (input: Input, ctx: Context) => {",
        "  const c = await import(input.itemId);",
        "  return { a, b, c, q: input.quantity, n: input.notes };",
        "};",
      ].join("\n"),
    });
    expect(result.refusals.map((r) => [r.rule, r.line])).toEqual([
      ["import-outside-module", 1],
      ["import-outside-module", 2],
      ["import-outside-module", 4],
    ]);
    expect(result.refusals[0]?.message).toContain("outside the module's directory");
  });

  it("refuses an import of a file the module does not hold, with the extension reminder", () => {
    const result = check({
      "index.ts": [
        'import { helper } from "./helper";',
        'import { other } from "./other.ts";',
        "export default async (input: Input, ctx: Context) => ({ helper, other, i: input.itemId, q: input.quantity, n: input.notes });",
      ].join("\n"),
      "helper.ts": "export const helper = 1;",
    });
    expect(result.refusals.map((r) => [r.rule, r.line])).toEqual([
      ["import-unresolved", 1],
      ["import-unresolved", 2],
    ]);
    expect(result.refusals[0]?.hint).toContain("extension included");
  });

  it("refuses an absolute URL, a template starting http and a protocol-relative path given to fetch; a vendor path passes", () => {
    const result = check({
      "index.ts": [
        "export default async (input: Input, ctx: Context) => {",
        '  await ctx.fetch("https://api.vendor.com/orders");',
        "  await ctx.fetch(`http://${input.itemId}.vendor.com/x`);",
        '  await ctx.fetch("//api.vendor.com/orders");',
        '  await ctx.fetch("/orders?" + new URLSearchParams({ q: String(input.quantity) }));',
        "  await ctx.fetch(`/orders/${input.notes}`);",
        "  return { ok: true };",
        "};",
      ].join("\n"),
    });
    expect(result.refusals.map((r) => [r.rule, r.line])).toEqual([
      ["fetch-absolute-url", 2],
      ["fetch-absolute-url", 3],
      ["fetch-absolute-url", 4],
    ]);
    expect(result.refusals[0]?.hint).toContain('"/v1/orders"');
  });

  it("refuses a bare fetch, since a module has no route out but ctx", () => {
    const result = check({
      "index.ts":
        'export default async (input: Input, ctx: Context) => (await fetch("/x")).json();',
    });
    expect(rules(result.refusals)).toEqual(["global-fetch"]);
    expect(result.refusals[0]?.hint).toContain("ctx.fetch");
  });
});

/**
 * ADR 0013: a package import resolves only into the version's own `node_modules`, so it is allowed
 * only when the module's `package.json` declares it — the `dependencies` the check is given.
 */
describe("imports of packages", () => {
  it("refuses a package the module does not declare, naming the package to declare", () => {
    const result = check({
      "index.ts": [
        'import lodash from "lodash";',
        'import { WebClient } from "@slack/web-api/dist/WebClient";',
        `export default async (input: Input, ctx: Context) => ({ lodash, WebClient, ${READS_INPUT} });`,
      ].join("\n"),
    });
    expect(result.refusals.map((r) => [r.rule, r.line])).toEqual([
      ["import-not-vendored", 1],
      ["import-not-vendored", 2],
    ]);
    expect(result.refusals[0]?.message).toContain("package.json does not declare");
    expect(result.refusals[0]?.message).toContain("package policy");
    expect(result.refusals[0]?.hint).toContain('Declare "lodash" under dependencies');
    expect(result.refusals[1]?.hint).toContain('Declare "@slack/web-api" under dependencies');
  });

  it("allows a declared package, its subpaths included, and types its exports as any", () => {
    const result = check(
      {
        "index.ts": [
          'import { z } from "zod";',
          'import fmt from "date-fns/format";',
          "export default async (input: Input, ctx: Context) => {",
          "  const shape = z.object({ id: z.string() });",
          `  return { parsed: shape.parse({ id: input.itemId }), when: fmt(new Date(), "yyyy"), q: input.quantity, n: input.notes };`,
          "};",
        ].join("\n"),
      },
      { dependencies: ["zod", "date-fns"] },
    );
    expect(result.refusals).toEqual([]);
  });

  it("still refuses node:child_process and a relative path outside the module whatever is declared", () => {
    const result = check(
      {
        "index.ts": [
          'import { exec } from "node:child_process";',
          'import { a } from "../a.ts";',
          `export default async (input: Input, ctx: Context) => ({ exec, a, ${READS_INPUT} });`,
        ].join("\n"),
      },
      { dependencies: ["child_process", "../a.ts"] },
    );
    expect(rules(result.refusals)).toEqual(["banned-module", "import-outside-module"]);
  });

  it("reads the dependencies off the module's package.json through readModuleSources", () => {
    const sources = readModuleSources([
      { path: "./index.ts", content: CLEAN_TS },
      {
        path: "package.json",
        content: JSON.stringify({ dependencies: { "@slack/web-api": "7.15.1", zod: "4.4.3" } }),
      },
    ]);
    expect(sources).toEqual({
      files: [
        { path: "index.ts", content: CLEAN_TS },
        { path: "package.json", content: expect.any(String) },
      ],
      entry: "index.ts",
      dependencies: ["@slack/web-api", "zod"],
    });
    expect(dependenciesOf([{ path: "package.json", content: "not json" }])).toEqual([]);
    expect(dependenciesOf([{ path: "package.json", content: '{"dependencies":["zod"]}' }])).toEqual(
      [],
    );
    expect(
      dependenciesOf([{ path: "lib/package.json", content: '{"dependencies":{"a":"1"}}' }]),
    ).toEqual([]);
  });
});

/**
 * ADR 0010: a client constructed from a vendored package takes `ctx.proxyKey` as its credential and a
 * `ctx.proxyBase(…)` call as its base, and nothing else in either slot. The rule is mechanical and
 * literal; every refusal names the file, line and column of the slot.
 */
describe("an SDK bound to the proxy", () => {
  const LINEAR = { dependencies: ["@linear/sdk"] };
  const SLACK = { dependencies: ["@slack/web-api"] };
  const sdk = (construction: string, deps = LINEAR) =>
    check(
      {
        "index.ts": [
          'import { LinearClient } from "@linear/sdk";',
          'import { WebClient } from "@slack/web-api";',
          "export default async (input: Input, ctx: Context) => {",
          `  const client = ${construction};`,
          `  return { ok: Boolean(client), ${READS_INPUT} };`,
          "};",
        ].join("\n"),
      },
      { dependencies: [...deps.dependencies, "@slack/web-api", "@linear/sdk"] },
    );

  it("passes with ctx.proxyKey as the credential and ctx.proxyBase() as the base", () => {
    const result = sdk("new LinearClient({ apiKey: ctx.proxyKey, apiUrl: ctx.proxyBase() })");
    expect(result.refusals).toEqual([]);
    expect(result.advice).toEqual([]);
  });

  it("passes a base for another declared host, and Slack's positional token with allowAbsoluteUrls: false", () => {
    expect(
      sdk(
        'new WebClient(ctx.proxyKey, { slackApiUrl: ctx.proxyBase("slack.com"), allowAbsoluteUrls: false })',
      ).refusals,
    ).toEqual([]);
    expect(
      sdk(
        'new LinearClient({ apiKey: ctx["proxyKey"], baseUrl: (ctx.proxyBase("api.linear.app")) })',
      ).refusals,
    ).toEqual([]);
  });

  it("refuses a literal host as the base, at its line and column", () => {
    const result = sdk(
      'new LinearClient({ apiKey: ctx.proxyKey, apiUrl: "https://api.linear.app/graphql" })',
    );
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "sdk-not-bound",
        file: "index.ts",
        line: 4,
        column: 59,
        message: expect.stringContaining(
          "points LinearClient at a base of its own (apiUrl: a string literal",
        ),
        hint: expect.stringContaining("apiUrl: ctx.proxyBase()"),
      }),
    ]);
  });

  it("refuses a computed base, even one built on ctx.proxyBase", () => {
    const result = sdk(
      "new LinearClient({ apiKey: ctx.proxyKey, apiUrl: `${ctx.proxyBase()}/graphql` })",
    );
    expect(result.refusals.map((r) => [r.rule, r.line, r.column])).toEqual([
      ["sdk-not-bound", 4, 59],
    ]);
    expect(result.refusals[0]?.message).toContain("a template literal");
    expect(result.refusals[0]?.hint).toContain("nothing computed");
  });

  it.each([
    [
      'a string literal, "lin_api_123"',
      'new LinearClient({ apiKey: "lin_api_123", apiUrl: ctx.proxyBase() })',
    ],
    [
      "a template literal",
      "new LinearClient({ apiKey: `Bearer ${input.itemId}`, apiUrl: ctx.proxyBase() })",
    ],
    [
      "the expression input.notes",
      "new LinearClient({ apiKey: input.notes, apiUrl: ctx.proxyBase() })",
    ],
    ["the variable apiKey", "new LinearClient({ apiKey, apiUrl: ctx.proxyBase() })"],
  ])("refuses %s as the credential", (kind, construction) => {
    const result = sdk(construction);
    expect(result.refusals.filter((r) => r.rule === "sdk-not-bound")).toEqual([
      expect.objectContaining({
        file: "index.ts",
        line: 4,
        column: 37,
        message: expect.stringContaining(`with a credential of its own (apiKey: ${kind}`),
        hint: expect.stringContaining("apiKey: ctx.proxyKey"),
      }),
    ]);
  });

  it("refuses a literal in Slack's positional token slot", () => {
    const result = sdk(
      'new WebClient("xoxb-1-2-3", { slackApiUrl: ctx.proxyBase(), allowAbsoluteUrls: false })',
    );
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "sdk-not-bound",
        line: 4,
        column: 32,
        message: expect.stringContaining(
          "constructs WebClient with a credential of its own (a string literal",
        ),
        hint: expect.stringContaining("new WebClient(ctx.proxyKey, {"),
      }),
    ]);
  });

  it("refuses a Slack client without allowAbsoluteUrls: false, at the construction", () => {
    const result = sdk("new WebClient(ctx.proxyKey, { slackApiUrl: ctx.proxyBase() })", SLACK);
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "sdk-not-bound",
        line: 4,
        column: 18,
        message: expect.stringContaining("without allowAbsoluteUrls: false"),
        hint: "Write new WebClient(ctx.proxyKey, { slackApiUrl: ctx.proxyBase(), allowAbsoluteUrls: false }).",
      }),
    ]);
    expect(
      sdk(
        "new WebClient(ctx.proxyKey, { slackApiUrl: ctx.proxyBase(), allowAbsoluteUrls: true })",
        SLACK,
      ).refusals,
    ).toHaveLength(1);
  });

  it("refuses a client with no credential slot, and one with no base slot", () => {
    const noKey = sdk("new LinearClient({ apiUrl: ctx.proxyBase() })");
    expect(noKey.refusals).toEqual([
      expect.objectContaining({
        rule: "sdk-not-bound",
        line: 4,
        column: 18,
        message: expect.stringContaining("without ctx.proxyKey as its credential"),
        hint: expect.stringContaining(
          "new LinearClient({ apiKey: ctx.proxyKey, baseUrl: ctx.proxyBase() })",
        ),
      }),
    ]);
    const noBase = sdk("new LinearClient({ apiKey: ctx.proxyKey })");
    expect(noBase.refusals.map((r) => r.message)).toEqual([
      expect.stringContaining("without a base URL pointing at the proxy"),
    ]);
    // Neither: two diagnostics, both at the construction.
    expect(rules(sdk("new LinearClient()").refusals)).toEqual(["sdk-not-bound", "sdk-not-bound"]);
  });

  it("refuses a spread, an authentication header, and an option it cannot name", () => {
    const spread = sdk("new LinearClient({ ...input, apiKey: ctx.proxyKey })");
    expect(spread.refusals.map((r) => [r.rule, r.column])).toEqual([["sdk-not-bound", 37]]);
    expect(spread.refusals[0]?.message).toContain("from a spread");

    const header = sdk(
      'new LinearClient({ apiKey: ctx.proxyKey, apiUrl: ctx.proxyBase(), headers: { Authorization: "Bearer x", accept: "json" } })',
    );
    expect(header.refusals.map((r) => r.message)).toEqual([
      expect.stringContaining("sets the Authorization header on LinearClient"),
    ]);

    const computed = sdk(
      'new LinearClient({ apiKey: ctx.proxyKey, apiUrl: ctx.proxyBase(), [input.notes ?? "x"]: 1 })',
    );
    expect(computed.refusals.map((r) => r.message)).toEqual([
      expect.stringContaining("an option the check cannot name"),
    ]);
  });

  it("holds a factory call with a credential or base option to the same rule", () => {
    const result = check(
      {
        "index.ts": [
          'import { createClient } from "@supabase/supabase-js";',
          "export default async (input: Input, ctx: Context) => {",
          '  const supabase = createClient({ auth: "anon-key", url: ctx.proxyBase() });',
          `  return { ok: Boolean(supabase), ${READS_INPUT} };`,
          "};",
        ].join("\n"),
      },
      { dependencies: ["@supabase/supabase-js"] },
    );
    expect(result.refusals.map((r) => [r.rule, r.line, r.column])).toEqual([
      ["sdk-not-bound", 3, 35],
    ]);
  });

  it("follows the class through a namespace import, a variable, and a sibling that re-exports it", () => {
    const namespaced = check(
      {
        "index.ts": [
          'import * as slack from "@slack/web-api";',
          "export default async (input: Input, ctx: Context) => {",
          '  const client = new slack.WebClient("xoxb", { slackApiUrl: ctx.proxyBase(), allowAbsoluteUrls: false });',
          `  return { ok: Boolean(client), ${READS_INPUT} };`,
          "};",
        ].join("\n"),
      },
      SLACK,
    );
    expect(namespaced.refusals.map((r) => [r.rule, r.line, r.column])).toEqual([
      ["sdk-not-bound", 3, 38],
    ]);

    const relayed = check(
      {
        "index.ts": [
          'import { Client } from "./lib/client.ts";',
          "export default async (input: Input, ctx: Context) => {",
          "  const client = new Client({ apiKey: ctx.proxyKey });",
          `  return { ok: Boolean(client), ${READS_INPUT} };`,
          "};",
        ].join("\n"),
        "lib/client.ts": [
          'import { LinearClient } from "@linear/sdk";',
          "const Impl = LinearClient;",
          "export { Impl as Client };",
        ].join("\n"),
      },
      LINEAR,
    );
    expect(relayed.refusals.map((r) => [r.rule, r.file, r.line])).toEqual([
      ["sdk-not-bound", "index.ts", 3],
    ]);
    expect(relayed.refusals[0]?.message).toContain("without a base URL");
  });

  it("names the option slots it inspects", () => {
    for (const name of ["apiKey", "auth", "token", "accessToken"]) {
      expect(SDK_CREDENTIAL_OPTIONS).toContain(name);
    }
    for (const name of [
      "apiUrl",
      "baseUrl",
      "baseURL",
      "endpointUrl",
      "rootUrl",
      "slackApiUrl",
      "host",
    ]) {
      expect(SDK_BASE_OPTIONS).toContain(name);
    }
  });
});

/**
 * ADR 0008: the annotations come from the methods the module's calls use, never from anything the
 * module declares about itself. `GET`/`HEAD` through `ctx.fetch` are reads, `DELETE` is destructive,
 * everything else — and everything the check cannot classify — is a write.
 */
describe("derived annotations", () => {
  const tool = (
    body: string,
    files: Record<string, string> = {},
    dependencies: string[] = [],
    prelude: string[] = [],
  ) =>
    check(
      {
        "index.ts": [
          ...prelude,
          ...Object.keys(files).map((path) => `import { helper } from "./${path}";`),
          "export default async (input: Input, ctx: Context) => {",
          body,
          `  return { ${READS_INPUT}${Object.keys(files).length > 0 ? ", helper" : ""} };`,
          "};",
        ].join("\n"),
        ...files,
      },
      { dependencies },
    ).annotations;

  it("marks a module of GET and HEAD reads read-only, whatever the method's case", () => {
    expect(
      tool(
        [
          '  await ctx.fetch("/items");',
          '  await ctx.fetch("/items/1", { method: "get" });',
          '  await ctx.fetch("/items/2", { method: "HEAD", headers: { accept: "application/json" } });',
        ].join("\n"),
      ),
    ).toEqual(READ);
  });

  it("marks a module with no call at all read-only", () => {
    expect(tool("  const total = input.quantity * 2; void total;")).toEqual(READ);
  });

  it("marks a POST, PUT or PATCH a write, and a DELETE destructive", () => {
    expect(tool('  await ctx.fetch("/orders", { method: "POST", body: "{}" });')).toEqual(WRITE);
    expect(tool('  await ctx.fetch("/orders/1", { method: "patch" });')).toEqual(WRITE);
    expect(
      tool('  await ctx.fetch("/items");\n  await ctx.fetch("/orders/1", { method: "DELETE" });'),
    ).toEqual(DESTRUCTIVE);
  });

  it("counts a method it cannot read as a write: a variable init, a shorthand, a spread, a computed method", () => {
    expect(tool('  const init = { method: "GET" };\n  await ctx.fetch("/items", init);')).toEqual(
      WRITE,
    );
    expect(tool('  const method = "GET";\n  await ctx.fetch("/items", { method });')).toEqual(
      WRITE,
    );
    expect(tool('  await ctx.fetch("/items", { ...{}, headers: {} });')).toEqual(WRITE);
    expect(tool('  await ctx.fetch("/items", { method: input.notes ?? "GET" });')).toEqual(WRITE);
  });

  it("counts every call into an SDK as a write, since the check cannot see its method", () => {
    expect(
      tool(
        [
          "  const client = new LinearClient({ apiKey: ctx.proxyKey, apiUrl: ctx.proxyBase() });",
          "  const issues = await client.issues();",
          "  void issues;",
        ].join("\n"),
        {},
        ["@linear/sdk"],
        ['import { LinearClient } from "@linear/sdk";'],
      ),
    ).toEqual(WRITE);
  });

  it("reads the helpers too, so a DELETE in a sibling is still destructive", () => {
    expect(
      tool('  await ctx.fetch("/items");', {
        "lib/remove.ts":
          "export const helper = (ctx: Context) => ctx.fetch(`/items/1`, { method: 'DELETE' });",
      }),
    ).toEqual(DESTRUCTIVE);
  });

  it("takes nothing from what the module says about itself", () => {
    expect(
      tool(
        [
          "  const annotations = { readOnly: true, destructive: false };",
          '  await ctx.fetch("/orders", { method: "POST", body: JSON.stringify(annotations) });',
        ].join("\n"),
      ),
    ).toEqual(WRITE);
  });

  it("answers UNKNOWN_ANNOTATIONS for a module it could not read", () => {
    const result = check({ "helper.ts": "export const a = 1;" }, { entry: "index.ts" });
    expect(result.annotations).toEqual(UNKNOWN_ANNOTATIONS);
    expect(UNKNOWN_ANNOTATIONS).toEqual({ readOnly: false, destructive: true });
  });
});

describe("TypeScript that Node cannot strip", () => {
  it("refuses an enum, a namespace, a parameter property, import =, export = and a decorator", () => {
    const result = check({
      "index.ts": [
        "enum Status { Open }",
        "namespace NS { export const a = 1; }",
        "class C { constructor(public x: number) {} }",
        'import fs = require("node:fs");',
        "function dec(target: unknown, key: string) {}",
        "class D { @dec method() {} }",
        "declare enum Fine { A }",
        "declare namespace AlsoFine { const b: number; }",
        "export default async (input: Input, ctx: Context) => ({ s: Status.Open, a: NS.a, c: new C(1), fs, d: new D(), i: input.itemId, q: input.quantity, n: input.notes });",
      ].join("\n"),
    });
    expect(result.refusals.map((r) => [r.rule, r.line])).toEqual([
      ["non-erasable-syntax", 1],
      ["non-erasable-syntax", 2],
      ["non-erasable-syntax", 3],
      ["non-erasable-syntax", 4],
      ["non-erasable-syntax", 6],
    ]);
    expect(result.refusals[0]?.message).toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.refusals[0]?.hint).toContain("union of literals");
  });

  it("refuses export =", () => {
    const result = check({
      "index.ts": "const f = async (input: Input, ctx: Context) => 1;\nexport = f;",
    });
    expect(rules(result.refusals)).toContain("non-erasable-syntax");
  });

  it("refuses a JSX file by its extension", () => {
    const result = check({ "index.ts": CLEAN_TS, "view.tsx": "export const V = () => <div />;" });
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "non-erasable-syntax",
        file: "view.tsx",
        message: expect.stringContaining("JSX"),
      }),
    ]);
  });

  it("refuses a type imported as a value, which Node cannot elide", () => {
    const result = check({
      "index.ts": [
        'import { Order } from "./types.ts";',
        "export default async (input: Input, ctx: Context): Promise<Order> => ({ id: input.itemId, q: input.quantity, n: input.notes });",
      ].join("\n"),
      "types.ts": "export type Order = { id: string; q: number; n?: string };",
    });
    expect(rules(result.refusals)).toEqual(["type-import"]);
    expect(result.refusals[0]?.hint).toContain("import type");
  });
});

describe("advice", () => {
  it("names an implicit any, a declared field never read, and a result JSON would lose", () => {
    const result = check({
      "index.ts": [
        "const double = (n) => n * 2;",
        "export default async (input: Input, ctx: Context) => ({ cb: () => 1, d: double(input.quantity), i: input.itemId });",
      ].join("\n"),
    });
    expect(result.refusals).toEqual([]);
    expect(result.advice.map((a) => [a.rule, a.line])).toEqual([
      ["implicit-any", 1],
      ["unread-input-field", 2],
      ["non-json-return", 2],
    ]);
    expect(result.advice[1]?.message).toBe(
      "The schema declares notes but the module never reads it.",
    );
    expect(result.advice[2]?.message).toContain("result.cb is a function");
  });

  it("flags a Map in the result, a void return, and a missing schema", () => {
    const withMap = check({
      "index.ts":
        "export default async (input: Input, ctx: Context) => ({ m: new Map<string, number>(), i: input.itemId, q: input.quantity, n: input.notes });",
    });
    expect(withMap.advice.map((a) => a.rule)).toEqual(["non-json-return"]);
    expect(withMap.advice[0]?.message).toContain("result.m is a Map");

    // `JSON.stringify(input)` hands the whole input on, so no field counts as unread.
    const returnsNothing = check({
      "index.ts":
        'export default async (input: Input, ctx: Context) => {\n  await ctx.fetch("/orders", { method: "POST", body: JSON.stringify(input) });\n};',
    });
    expect(returnsNothing.advice.map((a) => a.rule)).toEqual(["no-return"]);

    const spreads = check({
      "index.ts":
        "export default async (input: Input, ctx: Context) => ({ ...input, sent: (await ctx.fetch(`/orders?${new URLSearchParams(input as Record<string, string>)}`)).ok });",
    });
    expect(spreads.advice).toEqual([]);

    const noSchema = check(
      {
        "index.ts":
          "export default async (input: Input, ctx: Context) => ({ anything: input.whatever });",
      },
      { schema: null },
    );
    expect(noSchema.refusals).toEqual([]);
    expect(noSchema.advice.map((a) => a.rule)).toEqual(["no-input-schema"]);
  });
});

describe("the entry", () => {
  it("is refused when the module does not hold it", () => {
    const result = check({ "helper.ts": "export const a = 1;" }, { entry: "index.ts" });
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "entry-missing",
        file: "index.ts",
        line: 1,
        column: 1,
        text: "",
      }),
    ]);
  });

  it("may be a single file of any name", () => {
    const result = check(
      {
        "create-order.mjs":
          "export default async (input, ctx) => ({ i: input.itemId, q: input.quantity, n: input.notes });",
      },
      { entry: "create-order.mjs" },
    );
    expect(result).toEqual({
      entry: "create-order.mjs",
      refusals: [],
      advice: [],
      annotations: READ,
    });
  });
});

describe("inputTypeFromSchema", () => {
  it("maps objects, required, arrays, enums, unions, nullability and nesting; unknown for the rest", () => {
    expect(
      inputTypeFromSchema({
        type: "object",
        properties: {
          id: { type: "string" },
          count: { type: "integer" },
          ok: { type: "boolean" },
          none: { type: "null" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["open", "closed"] },
          kind: { const: "order" },
          either: { anyOf: [{ type: "string" }, { type: "number" }] },
          maybe: { type: ["string", "null"] },
          soft: { type: "number", nullable: true },
          nested: { type: "object", properties: { deep: { type: "boolean" } } },
          free: { type: "object" },
          "with-dash": { type: "string" },
          odd: { format: "date-time" },
          pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
        },
        required: ["id", "count", "with-dash"],
      }),
    ).toBe(
      '{ id: string; count: number; ok?: boolean; none?: null; tags?: string[]; status?: "open" | "closed"; kind?: "order"; either?: string | number; maybe?: string | null; soft?: number | null; nested?: { deep?: boolean }; free?: Record<string, unknown>; "with-dash": string; odd?: unknown; pair?: [string, number] }',
    );
  });

  it("declares only the declared properties, whatever additionalProperties says", () => {
    expect(inputTypeFromSchema({ type: "object", properties: { a: { type: "string" } } })).toBe(
      "{ a?: string }",
    );
    expect(
      inputTypeFromSchema({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: true,
      }),
    ).toBe("{ a?: string }");
    expect(inputTypeFromSchema({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    );
    expect(inputTypeFromSchema("nonsense")).toBe("unknown");
  });
});

/** The door: a worker thread under a size and a time budget (`module-check.ts`). */
describe("checkModule", () => {
  it("answers as the core does, from a worker thread, dependencies included", async () => {
    const result = await checkModule({
      files: [{ path: "index.ts", content: CLEAN_TS }],
      entry: "index.ts",
      inputSchema: SCHEMA,
    });
    expect(result).toEqual({ entry: "index.ts", refusals: [], advice: [], annotations: WRITE });

    const vendored = await checkModule({
      files: [
        {
          path: "index.ts",
          content: [
            'import { LinearClient } from "@linear/sdk";',
            "export default async (input: Input, ctx: Context) => {",
            "  const client = new LinearClient({ apiKey: ctx.proxyKey, apiUrl: ctx.proxyBase() });",
            `  return { ok: Boolean(client), ${READS_INPUT} };`,
            "};",
          ].join("\n"),
        },
      ],
      entry: "index.ts",
      inputSchema: SCHEMA,
      dependencies: ["@linear/sdk"],
    });
    expect(vendored.refusals).toEqual([]);
  }, 30_000);

  it("refuses a module over the size cap before starting a thread, in KiB", async () => {
    const result = await checkModule(
      { files: [{ path: "index.ts", content: "x".repeat(3 * 1024) }], entry: "index.ts" },
      { maxBytes: 2 * 1024 },
    );
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "budget",
        file: "index.ts",
        message: expect.stringContaining("3 KiB; the check reads up to 2 KiB"),
      }),
    ]);
    expect(result.annotations).toEqual(UNKNOWN_ANNOTATIONS);
    expect(MODULE_CHECK_MAX_BYTES).toBe(256 * 1024);
  });

  it("stops a check that does not finish in time, with a plain message", async () => {
    const result = await checkModule(
      { files: [{ path: "index.ts", content: CLEAN_TS }], entry: "index.ts", inputSchema: SCHEMA },
      { timeoutMs: 1 },
    );
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "budget",
        message: expect.stringContaining("did not finish within 0 seconds"),
      }),
    ]);
    expect(MODULE_CHECK_TIMEOUT_MS).toBe(10_000);
  });

  it("refuses a module with no entry without starting a thread", async () => {
    const result = await checkModule({ files: [{ path: "a.ts", content: "" }], entry: null });
    expect(result).toEqual({
      entry: null,
      refusals: [expect.objectContaining({ rule: "entry-missing", file: "a.ts" })],
      advice: [],
      annotations: UNKNOWN_ANNOTATIONS,
    });
  });
});

/**
 * What the check reads: a directory is every file under it with the runner's entry resolved and the
 * dependencies its package.json declares; a single file is its own entry. The sandbox seam that
 * produces the files is wired later; this takes files, not a handle.
 */
describe("readModuleSources", () => {
  it("reads a directory whole, with the entry the runner would resolve", () => {
    const tree = [
      { path: "lib/helper.ts", content: "export const x = 1;" },
      { path: "index.ts", content: "export default async () => 1;" },
    ];
    expect(readModuleSources(tree)).toEqual({ files: tree, entry: "index.ts", dependencies: [] });
    expect(readModuleSources([{ path: "./index.mjs", content: "x" }])).toMatchObject({
      files: [{ path: "index.mjs", content: "x" }],
      entry: "index.mjs",
    });
    expect(readModuleSources([{ path: "main.ts", content: "x" }])).toMatchObject({ entry: null });
  });

  it("reads a single file as its own entry, vendoring nothing", () => {
    expect(singleFileModule("/tools/.drafts/x/orders.mjs", "export default 1")).toEqual({
      files: [{ path: "orders.mjs", content: "export default 1" }],
      entry: "orders.mjs",
      dependencies: [],
    });
  });
});
