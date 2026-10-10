import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScriptedModel, type ModuleDraft, type ScriptedStep } from "@graft/model";
import type { UpstreamRequest } from "@graft/proxy";
import { proveCheck, proveReplay, proveTestInput, readStockRecording } from "@graft/stock/harness";
import { readStockWorkspace } from "@graft/stock/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type BuildOptions, buildStockTool, hostsOf, swapInto } from "./build";

/**
 * The stock build command end to end (GRA-246): the real acquire loop under a scripted model, the
 * real check, publish, runner and proxy, against a fake GitHub behind the maintainer's planted
 * token. What it writes must pass the stock harness unchanged, the token must reach no file, a
 * repair (`from`) must start from the current module and write the next version in its place, and a
 * failed job must write nothing.
 */

const TOKEN = "ghp_plantedMaintainerToken0123456789";
/** The maintainer's own account, as their repositories would show it: none may reach a file. */
const PLANTED = [
  "alice-liddell-salary",
  "acme-board-minutes",
  "Alice Liddell",
  "alice@acme-corp.example",
  "Acme Pty Ltd, confidential",
  "2026-10-09T19:45:12Z",
  "987654321",
];
const D = "$";

function moduleFor(perPage: number): string {
  return [
    "export default async (input: Input, ctx: Context) => {",
    `  const res = await ctx.fetch(\`/user/repos?affiliation=${D}{input.affiliation}&per_page=${perPage}\`);`,
    `  if (!res.ok) throw new Error(\`GET /user/repos ${D}{res.status}\`);`,
    "  const repos = (await res.json()) as { name: string; owner_note: string }[];",
    "  return repos.map((repo) => ({ name: repo.name, note: repo.owner_note }));",
    "};",
    "",
  ].join("\n");
}

const SCHEMA = {
  type: "object",
  properties: { affiliation: { type: "string" } },
  required: ["affiliation"],
  additionalProperties: false,
};

function draft(name: string, perPage: number): ModuleDraft {
  return {
    name,
    description: "Lists the authenticated user's most recently updated repositories.",
    inputSchema: SCHEMA,
    files: [{ path: "index.ts", content: moduleFor(perPage) }],
    // A value from the maintainer's account, as a get-by-id tool's test input must be.
    testInput: { affiliation: "acme-board-minutes" },
    proofReads: [{ path: "/user/repos?per_page=1" }],
  };
}

function passing(name: string, perPage: number): ScriptedStep[] {
  return [
    { on: "goal", answer: { kind: "write_module", draft: draft(name, perPage), note: "Drafted." } },
    { on: "proof", answer: { kind: "proceed", note: "The read answered as documented." } },
  ];
}

/** GitHub as far as these modules reach it: the repositories, with the token echoed back in one. */
function github(seen: UpstreamRequest[]) {
  return async (request: UpstreamRequest) => {
    seen.push(request);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.hostname !== "api.github.com" || url.pathname !== "/user/repos") {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const all = [
      { id: 987654321, name: "alice-liddell-salary", owner_note: `pushed with ${TOKEN}` },
      {
        id: 987654322,
        name: "acme-board-minutes",
        owner_note: "Alice Liddell <alice@acme-corp.example>, Acme Pty Ltd, confidential",
        pushed_at: "2026-10-09T19:45:12Z",
      },
      { id: 987654323, name: "modern", owner_note: "" },
    ];
    return Response.json(all.slice(0, Number(url.searchParams.get("per_page") ?? 30)));
  };
}

let workspace: string;
let seen: UpstreamRequest[];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "graft-stock-build-test-"));
  seen = [];
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function options(steps: ScriptedStep[], extra: Partial<BuildOptions> = {}) {
  const model = createScriptedModel(steps);
  return {
    model,
    options: {
      vendor: "github",
      goal: "List my most recently updated repositories",
      model,
      connections: { github: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } } },
      workspace,
      upstreamFetch: github(seen),
      readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
      maxAttempts: 2,
      ...extra,
    } satisfies BuildOptions,
  };
}

async function filesUnder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[path.slice(dir.length + 1)] = await readFile(path, "utf8");
    }
  }
  return out;
}

async function harnessProblems(): Promise<string[]> {
  const problems: string[] = [];
  for (const tool of await readStockWorkspace(workspace)) {
    problems.push(...(await proveCheck(tool)), ...proveTestInput(tool));
    const read = await readStockRecording(tool, workspace);
    if (!read.ok) problems.push(read.problem);
    else problems.push(...(await proveReplay(tool, read.recording)).problems);
  }
  return problems;
}

describe("buildStockTool", () => {
  it("writes a tool directory the harness passes unchanged, with the planted credential and personal data in no file", async () => {
    const { options: build } = options(passing("recent-repos", 2));
    const result = await buildStockTool(build);
    if (!result.ok) throw new Error(`${result.message}\n${(result.problems ?? []).join("\n")}`);

    expect(result).toMatchObject({ tool: "github__recent-repos", replaced: false });
    expect(result.files).toEqual([
      "index.ts",
      "manifest.json",
      "recording.json",
      "test-input.json",
    ]);
    const files = await filesUnder(join(workspace, "github", "recent-repos"));
    expect(Object.keys(files).sort()).toEqual(result.files);
    for (const [path, content] of Object.entries(files)) {
      expect(content, `${path} carries the planted credential`).not.toContain(TOKEN);
      for (const planted of PLANTED) {
        expect(content, `${path} carries ${planted}`).not.toContain(planted);
      }
    }
    expect(JSON.parse(files["manifest.json"] ?? "")).toEqual({
      name: "recent-repos",
      description: "Lists the authenticated user's most recently updated repositories.",
      inputSchema: SCHEMA,
      hosts: ["api.github.com"],
      annotations: { readOnly: true, destructive: false },
    });
    // Formatted by the repository's Biome before the proofs, so `pnpm run lint` passes as written.
    expect(files["manifest.json"]).toContain('"hosts": ["api.github.com"],');
    const recording = JSON.parse(files["recording.json"] ?? "");
    expect(recording).toMatchObject({
      format: 1,
      tool: "github__recent-repos",
      exchanges: [{ kind: "read", method: "GET" }],
    });
    // The test input is scrubbed with everything else, and the request built from it follows.
    const input = JSON.parse(files["test-input.json"] ?? "");
    expect(input.affiliation).toMatch(/^[a-z]{4}-[a-z]{5}-[a-z]{7}$/);
    expect(recording.input).toEqual(input);
    expect(recording.exchanges[0].url).toBe(
      `https://api.github.com/user/repos?affiliation=${input.affiliation}&per_page=2`,
    );
    // Scrubbed to the same shape, and the result is the module's over the scrubbed answers.
    const body = recording.exchanges[0].response.body.json as {
      name: string;
      owner_note: string;
    }[];
    expect(body).toHaveLength(2);
    expect(body[0]?.name).toMatch(/^[a-z]{5}-[a-z]{7}-[a-z]{6}$/);
    expect(body[0]?.owner_note).toMatch(/^[a-z]{6} [a-z]{4} \[redacted:credential\]$/);
    expect(recording.result).toEqual(
      body.map((repo) => ({ name: repo.name, note: repo.owner_note })),
    );
    // The vendor did see the token: the proxy injected it on every call, and on nothing else.
    expect(seen.length).toBeGreaterThan(0);

    expect(await harnessProblems()).toEqual([]);
  });

  it("makes a workspace that does not exist yet", async () => {
    const fresh = join(workspace, "fresh", "tools");
    const result = await buildStockTool(
      options(passing("recent-repos", 2), { workspace: fresh }).options,
    );
    if (!result.ok) throw new Error(`${result.message}\n${(result.problems ?? []).join("\n")}`);
    expect(await readdir(fresh)).toEqual(["github"]);
  });

  it("refuses to build over an existing tool without from, and writes nothing", async () => {
    expect((await buildStockTool(options(passing("recent-repos", 2)).options)).ok).toBe(true);
    const before = await filesUnder(workspace);

    const again = await buildStockTool(options(passing("recent-repos", 3)).options);
    expect(again).toMatchObject({ ok: false, failure: "tool_exists" });
    expect(await filesUnder(workspace)).toEqual(before);
  });

  it("with from, starts from the current module and writes the next version in its place", async () => {
    expect((await buildStockTool(options(passing("recent-repos", 2)).options)).ok).toBe(true);

    // The repair's draft calls itself something else; the stock tool keeps its name.
    const { model, options: repair } = options(passing("recent-repos-three", 3), {
      from: "recent-repos",
      goal: "List my three most recently updated repositories",
    });
    const result = await buildStockTool(repair);
    if (!result.ok) throw new Error(`${result.message}\n${(result.problems ?? []).join("\n")}`);
    expect(result).toMatchObject({ tool: "github__recent-repos", replaced: true });

    const hints = model.conversations[0]?.context.hints ?? "";
    expect(hints).toContain("Start from the current stock tool github__recent-repos");
    expect(hints).toContain("per_page=2");

    const tools = await readStockWorkspace(workspace);
    expect(tools.map((tool) => `${tool.vendor}__${tool.name}`)).toEqual(["github__recent-repos"]);
    expect(tools[0]?.files.find((file) => file.path === "index.ts")?.content).toContain(
      "per_page=3",
    );
    expect(await harnessProblems()).toEqual([]);
  });

  it("leaves the current version untouched when the repair fails its proof where it was copied", async () => {
    expect((await buildStockTool(options(passing("recent-repos", 2)).options)).ok).toBe(true);
    const before = await filesUnder(workspace);

    // A formatter that changes what the module calls, after the recording: the copy fails the replay.
    const result = await buildStockTool(
      options(passing("recent-repos", 3), {
        from: "recent-repos",
        format: async (dir) => {
          const path = join(dir, "index.ts");
          await writeFile(path, (await readFile(path, "utf8")).replace("/user/repos?", "/user/x?"));
          return null;
        },
      }).options,
    );
    expect(result).toMatchObject({ ok: false, failure: "harness_failed" });
    expect(await filesUnder(workspace)).toEqual(before);
    expect((await readdir(workspace)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "leaves the current version untouched when the repair cannot be copied whole",
    async () => {
      expect((await buildStockTool(options(passing("recent-repos", 2)).options)).ok).toBe(true);
      const before = await filesUnder(workspace);

      // A file the copy cannot read, after the files it has already copied: a copy that fails midway.
      const result = await buildStockTool(
        options(passing("recent-repos", 3), {
          from: "recent-repos",
          format: async (dir) => {
            const path = join(dir, "zz-unreadable.ts");
            await writeFile(path, "export {};\n");
            await chmod(path, 0o000);
            return null;
          },
        }).options,
      );
      expect(result).toMatchObject({ ok: false, failure: "write_failed" });
      expect(await filesUnder(workspace)).toEqual(before);
      expect((await readdir(workspace)).filter((name) => name.startsWith("."))).toEqual([]);
    },
  );

  it("writes nothing for a failed job, and answers its failure and last diagnostics", async () => {
    const broken: ModuleDraft = {
      ...draft("recent-repos", 2),
      files: [{ path: "index.ts", content: moduleFor(2).replace("/user/repos?", "/user/nope?") }],
    };
    const result = await buildStockTool(
      options([
        { on: "goal", answer: { kind: "write_module", draft: broken, note: "Drafted." } },
        { on: "proof", answer: { kind: "proceed", note: "Fine." } },
        { on: "dry_run_failed", answer: { kind: "give_up", reason: "The endpoint is not there." } },
      ]).options,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: "model_gave_up",
      message: "The model gave up: The endpoint is not there.",
    });
    if (result.ok) return;
    expect(result.lastDiagnostics).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("refuses a keyed starter with no connection, and an integration that is not a starter, before any job", async () => {
    const noConnection = await buildStockTool(options([], { connections: {} }).options);
    expect(noConnection).toMatchObject({ ok: false, failure: "connection_missing" });
    expect((noConnection as { message: string }).message).toContain("GRAFT_STOCK_LIVE_CONNECTIONS");

    const notStarter = await buildStockTool(options([], { vendor: "linear" }).options);
    expect(notStarter).toMatchObject({ ok: false, failure: "not_a_starter" });

    const noSuchTool = await buildStockTool(options([], { from: "nothing" }).options);
    expect(noSuchTool).toMatchObject({ ok: false, failure: "from_not_found" });

    for (const goal of ["   ", "x".repeat(4001)]) {
      expect(await buildStockTool(options([], { goal }).options)).toMatchObject({
        ok: false,
        failure: "goal_invalid",
      });
    }
    expect(seen).toEqual([]);
    expect(await readdir(workspace)).toEqual([]);
  });
});

describe("swapInto", () => {
  it("puts the current directory back when the new one cannot be moved into its place", async () => {
    const dir = join(workspace, "github", "tool");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), "current\n");
    const swapped = await swapInto(join(workspace, "missing"), dir, join(workspace, "aside"), {
      replace: true,
    });
    expect(swapped.ok).toBe(false);
    expect(await readFile(join(dir, "index.ts"), "utf8")).toBe("current\n");
    expect(await readdir(workspace)).toEqual(["github"]);
  });

  it("replaces the current directory with the new one", async () => {
    const dir = join(workspace, "github", "tool");
    const next = join(workspace, "next");
    await mkdir(dir, { recursive: true });
    await mkdir(next, { recursive: true });
    await writeFile(join(dir, "index.ts"), "current\n");
    await writeFile(join(next, "index.ts"), "next\n");
    expect(await swapInto(next, dir, join(workspace, "aside"), { replace: true })).toEqual({
      ok: true,
    });
    expect(await readFile(join(dir, "index.ts"), "utf8")).toBe("next\n");
  });
});

describe("swapInto, for a new tool", () => {
  it("refuses to land on a tool another build wrote meanwhile, and leaves that one", async () => {
    const dir = join(workspace, "github", "tool");
    const next = join(workspace, "next");
    await mkdir(dir, { recursive: true });
    await mkdir(next, { recursive: true });
    await writeFile(join(dir, "index.ts"), "first\n");
    await writeFile(join(next, "index.ts"), "second\n");
    const swapped = await swapInto(next, dir, join(workspace, "aside"), { replace: false });
    expect(swapped).toMatchObject({ ok: false, exists: true });
    expect(await readFile(join(dir, "index.ts"), "utf8")).toBe("first\n");
  });
});

describe("hostsOf", () => {
  const recording = (urls: string[]) => ({
    format: 1 as const,
    tool: "open-meteo__x",
    recordedAt: "2026-10-09T00:00:00Z",
    input: {},
    exchanges: urls.map((url) => ({
      kind: "read" as const,
      method: "GET" as const,
      url,
      response: { status: 200, headers: {} },
    })),
  });
  const hosts = ["api.open-meteo.com", "geocoding-api.open-meteo.com"];

  it("declares the hosts reached, in the starter's order, and not one a longer name contains", () => {
    const module = [
      { content: 'ctx.fetch("/v1/search", { host: "geocoding-api.open-meteo.com" })' },
    ];
    expect(
      hostsOf(recording(["https://geocoding-api.open-meteo.com/v1/search?name=x"]), module, hosts),
    ).toEqual(["geocoding-api.open-meteo.com"]);
  });

  it("declares a host the module names though the test input never reached it", () => {
    const module = [{ content: 'const forecast = "api.open-meteo.com";' }];
    expect(
      hostsOf(recording(["https://geocoding-api.open-meteo.com/v1/search"]), module, hosts),
    ).toEqual(hosts);
  });
});
