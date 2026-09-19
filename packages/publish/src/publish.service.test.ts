/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are module source text, and a template placeholder inside a plain string is exactly what a module holds. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkModule } from "@graft/check";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox/fake";
import type { InstallArgs, SandboxProcessResult } from "@graft/sandbox/types";
import {
  createFilesystemToolboxStore,
  createNoopToolboxMirror,
  type FilesystemToolboxStore,
  type ToolboxFile,
  type ToolboxMirror,
} from "@graft/toolbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex, sourceHashOf } from "./hash";
import { createFakeMetadataSource, type FakePackageMetadataSource } from "./metadata";
import { DEFAULT_PACKAGE_POLICY, type PackageMetadata } from "./policy";
import {
  type MirrorEvent,
  type PublishArgs,
  type PublishDeps,
  publishToolVersion,
} from "./publish.service";
import { createInMemoryToolDeps, fakeDb, type InMemoryToolDeps } from "./testing";

/**
 * The publish with fakes at every seam and the check for real (it is pure): the store over the fake
 * sandbox's toolbox root, the fake sandbox backend's `install` wrapped to leave a lockfile the way the
 * Docker backing does, a table for the registry, two arrays for the rows. What is asserted is what a
 * caller and the toolbox directory show — a version on disk, a row, a pointer, a diagnostic naming a
 * package and a rule — never how the service got there.
 */

const NOW = new Date("2026-09-09T12:00:00Z");
const PERSON = "person1";
const TOOLBOX = PERSON;
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

const HELLO_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};
const PAD_SCHEMA = {
  type: "object",
  properties: { word: { type: "string" }, width: { type: "integer" } },
  required: ["word", "width"],
};

/** Attested, old, popular — what the registry says about a package the policy admits. */
const ADMITTED: PackageMetadata = {
  publishedAt: new Date("2018-01-17T19:39:14.694Z"),
  weeklyDownloads: 13_621_015,
  hasProvenance: true,
};

async function readFixture(name: string): Promise<ToolboxFile[]> {
  const dir = join(FIXTURES, name);
  const names = (await readdir(dir)).filter((file) => file !== "schema.json").sort();
  return Promise.all(
    names.map(async (file) => ({ path: file, content: await readFile(join(dir, file), "utf8") })),
  );
}

/** A `package.json` declaring the given packages, in the fixture's shape. */
const manifestOf = (dependencies: Record<string, string>) => ({
  path: "package.json",
  content: `${JSON.stringify({ dependencies }, null, 2)}\n`,
});

type Harness = {
  sandbox: FakeSandboxBackend;
  store: FilesystemToolboxStore;
  tool: InMemoryToolDeps;
  metadata: FakePackageMetadataSource;
  mirror: ToolboxMirror & { calls: { toolboxId: string; versionPath: string }[] };
  install: ReturnType<typeof vi.fn<(args: InstallArgs) => Promise<SandboxProcessResult>>>;
  mirrorEvents: MirrorEvent[];
  deps: PublishDeps;
};

let h: Harness;

beforeEach(async () => {
  const sandbox = createFakeSandboxBackend();
  const store = createFilesystemToolboxStore({ root: join(sandbox.root, "toolboxes") });
  const tool = createInMemoryToolDeps({ now: () => NOW });
  const metadata = createFakeMetadataSource({});
  const mirror = createNoopToolboxMirror();
  const mirrorEvents: MirrorEvent[] = [];
  // The fake backing's `install` is a no-op; the Docker backing leaves a lockfile behind. The
  // wrapper does what the real one would, so the lockfile hash is asserted against a known text.
  const install = vi.fn(async (args: InstallArgs): Promise<SandboxProcessResult> => {
    const result = await sandbox.install(args);
    await store.writeTree(args.toolboxId, args.versionPath, [
      { path: "package-lock.json", content: `{"lockfileVersion":3,"for":"${args.versionPath}"}` },
      { path: "node_modules/left-pad/index.js", content: "module.exports = () => 'x';" },
    ]);
    return result;
  });
  h = {
    sandbox,
    store,
    tool,
    metadata,
    mirror,
    install,
    mirrorEvents,
    deps: {
      db: fakeDb,
      store,
      mirror,
      sandbox: { install },
      metadata,
      policy: DEFAULT_PACKAGE_POLICY,
      tool,
      check: checkModule,
      now: () => NOW,
      onMirror: (event) => mirrorEvents.push(event),
    },
  };
});

afterEach(async () => {
  await h.sandbox.close();
});

async function draft(jobId: string, files: ToolboxFile[]): Promise<string> {
  const path = `.drafts/${jobId}`;
  await h.store.writeTree(TOOLBOX, path, files);
  return path;
}

function args(overrides: Partial<PublishArgs> & Pick<PublishArgs, "draftPath">): PublishArgs {
  return {
    personId: PERSON,
    toolboxId: TOOLBOX,
    vendor: "demo",
    name: "hello",
    description: "Greets a name through the vendor",
    inputSchema: HELLO_SCHEMA,
    jobId: "job1",
    agentId: "agent1",
    ...overrides,
  };
}

const publish = (overrides: Partial<PublishArgs> & Pick<PublishArgs, "draftPath">) =>
  publishToolVersion(h.deps, args(overrides));

describe("a module with no dependencies", () => {
  it("writes v1 from the draft, records the check and moves the pointer, without an install", async () => {
    const files = await readFixture("hello");
    const draftPath = await draft("job1", files);

    const result = await publish({ draftPath });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.version.path).toBe("tools/demo/hello/v1");
    expect(result.version.versionNumber).toBe(1);
    expect(result.version.sourceHash).toBe(sourceHashOf(files));
    expect(result.version.lockfileHash).toBeNull();
    expect(result.version.publisherJobId).toBe("job1");
    expect(result.version.writesInvolved).toBe(false);
    expect(result.version.checkOutput).toEqual({
      entry: "index.ts",
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
    });
    expect(result.annotations).toEqual({ readOnly: true, destructive: false });
    expect(result.advice).toEqual([]);
    expect(result.dependencies).toEqual([]);
    expect(result.tool).toMatchObject({
      personId: PERSON,
      vendor: "demo",
      name: "hello",
      description: "Greets a name through the vendor",
      inputSchema: HELLO_SCHEMA,
      readOnly: true,
      destructive: false,
      currentVersionId: result.version.id,
    });

    expect(await h.store.readTree(TOOLBOX, "tools/demo/hello/v1")).toEqual(files);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.metadata.lookups).toEqual([]);
    // The draft is the job's; the publish leaves it for a republish.
    expect(await h.store.exists(TOOLBOX, draftPath)).toBe(true);
  });

  it("publishes a single-file draft as the entry the runner resolves", async () => {
    const [index] = await readFixture("hello");
    await h.store.writeTree(TOOLBOX, ".drafts/job1", [
      { path: "tool.ts", content: index?.content ?? "" },
    ]);

    const result = await publish({ draftPath: ".drafts/job1/tool.ts" });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await h.store.readTree(TOOLBOX, "tools/demo/hello/v1")).map((f) => f.path)).toEqual([
      "index.ts",
    ]);
  });

  it("a second publish writes v2 and moves the pointer, and v1 stays on disk and in the rows", async () => {
    const first = await readFixture("hello");
    await publish({ draftPath: await draft("job1", first) });

    const second = first.map((file) => ({ ...file, content: `${file.content}// v2\n` }));
    const result = await publish({
      draftPath: await draft("job2", second),
      jobId: "job2",
      description: "Greets a name through the vendor, politely",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.version.path).toBe("tools/demo/hello/v2");
    expect(result.version.versionNumber).toBe(2);
    expect(result.tool.currentVersionId).toBe(result.version.id);
    expect(result.tool.description).toBe("Greets a name through the vendor, politely");

    expect(h.tool.tools).toHaveLength(1);
    expect(h.tool.versions.map((v) => v.path)).toEqual([
      "tools/demo/hello/v1",
      "tools/demo/hello/v2",
    ]);
    expect(await h.store.readTree(TOOLBOX, "tools/demo/hello/v1")).toEqual(first);
    expect(await h.store.readTree(TOOLBOX, "tools/demo/hello/v2")).toEqual(second);
    expect(await h.store.list(TOOLBOX, "tools/demo/hello")).toEqual(["v1", "v2"]);
  });

  it("puts the check's annotations on the tool row: a write is not read-only, a delete is destructive", async () => {
    const write = await publish({
      draftPath: await draft("job1", [
        {
          path: "index.ts",
          content:
            'export default async (input: Input, ctx: Context) => (await ctx.fetch("/greetings", { method: "POST", body: JSON.stringify({ name: input.name }) })).json();',
        },
      ]),
    });
    expect(write.ok && write.tool).toMatchObject({ readOnly: false, destructive: false });
    expect(write.ok && write.version.writesInvolved).toBe(true);

    const destroy = await publish({
      name: "forget",
      draftPath: await draft("job2", [
        {
          path: "index.ts",
          content:
            'export default async (input: Input, ctx: Context) => ({ ok: (await ctx.fetch(`/greetings/${input.name}`, { method: "DELETE" })).ok });',
        },
      ]),
    });
    expect(destroy.ok && destroy.tool).toMatchObject({ readOnly: false, destructive: true });
  });

  it("under activate: false, a first publish makes the tool with the draft's definition and no current version", async () => {
    const files = await readFixture("hello");
    const result = await publish({ draftPath: await draft("job1", files), activate: false });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.version).toMatchObject({ path: "tools/demo/hello/v1", versionNumber: 1 });
    expect(result.tool).toMatchObject({
      vendor: "demo",
      name: "hello",
      description: "Greets a name through the vendor",
      inputSchema: HELLO_SCHEMA,
      readOnly: true,
      destructive: false,
      currentVersionId: null,
    });
    expect(h.tool.tools[0]?.currentVersionId).toBeNull();
    expect(h.tool.versions.map((v) => v.path)).toEqual(["tools/demo/hello/v1"]);
    expect(await h.store.readTree(TOOLBOX, "tools/demo/hello/v1")).toEqual(files);
    // The mirror is still told: the version is in the toolbox whether or not it is current.
    await vi.waitFor(() => expect(h.mirrorEvents).toHaveLength(1));
    expect(h.mirrorEvents[0]).toMatchObject({
      outcome: "mirrored",
      versionPath: "tools/demo/hello/v1",
    });
  });

  it("under activate: false, a republish writes the version and leaves the definition and the pointer where they were", async () => {
    const first = await readFixture("hello");
    const activated = await publish({ draftPath: await draft("job1", first) });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;

    const second = first.map((file) => ({ ...file, content: `${file.content}// v2\n` }));
    const result = await publish({
      draftPath: await draft("job2", second),
      jobId: "job2",
      description: "Greets a name through the vendor, politely",
      inputSchema: { ...HELLO_SCHEMA, properties: { name: { type: "string", minLength: 1 } } },
      activate: false,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.version).toMatchObject({ path: "tools/demo/hello/v2", versionNumber: 2 });
    expect(result.tool).toMatchObject({
      description: "Greets a name through the vendor",
      inputSchema: HELLO_SCHEMA,
      currentVersionId: activated.version.id,
    });
    expect(h.tool.tools[0]).toMatchObject({
      description: "Greets a name through the vendor",
      currentVersionId: activated.version.id,
    });
    expect(h.tool.versions.map((v) => v.path)).toEqual([
      "tools/demo/hello/v1",
      "tools/demo/hello/v2",
    ]);
    expect(await h.store.readTree(TOOLBOX, "tools/demo/hello/v2")).toEqual(second);
  });

  it("under activate: false, a republish onto a tool bound to another connection rebinds it to this publish's and leaves the rest where it was (GRA-122)", async () => {
    const first = await readFixture("hello");
    const activated = await publish({
      draftPath: await draft("job1", first),
      defaultConnectionId: "conn_old",
    });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(h.tool.tools[0]?.defaultConnectionId).toBe("conn_old");

    // The job's connection differs from the row's default — the person revoked the old one and
    // connected the vendor again — so the binding moves at publish, and nothing else does.
    const second = first.map((file) => ({ ...file, content: `${file.content}// v2\n` }));
    const result = await publish({
      draftPath: await draft("job2", second),
      jobId: "job2",
      description: "Greets a name through the vendor, politely",
      defaultConnectionId: "conn_new",
      activate: false,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.version).toMatchObject({ path: "tools/demo/hello/v2", versionNumber: 2 });
    expect(result.tool).toMatchObject({
      defaultConnectionId: "conn_new",
      description: "Greets a name through the vendor",
      currentVersionId: activated.version.id,
    });
    expect(h.tool.tools[0]).toMatchObject({
      defaultConnectionId: "conn_new",
      description: "Greets a name through the vendor",
      currentVersionId: activated.version.id,
    });

    // The same connection again writes nothing to the tool row.
    const update = vi.spyOn(h.tool, "updateAuthoredTool");
    const third = first.map((file) => ({ ...file, content: `${file.content}// v3\n` }));
    const unchanged = await publish({
      draftPath: await draft("job3", third),
      jobId: "job3",
      defaultConnectionId: "conn_new",
      activate: false,
    });
    expect(unchanged.ok).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(h.tool.tools[0]?.defaultConnectionId).toBe("conn_new");
  });

  it("carries the check's advice on a success", async () => {
    const result = await publish({
      draftPath: await draft("job1", [
        {
          path: "index.ts",
          content:
            'export default async (input: Input, ctx: Context) => ({ ok: (await ctx.fetch("/greetings")).ok });',
        },
      ]),
    });
    expect(result.ok).toBe(true);
    expect(result.advice.map((d) => d.rule)).toEqual(["unread-input-field"]);
  });
});

describe("a module declaring packages", () => {
  it("installs an allowlisted package once, into the version, and records the lockfile's hash", async () => {
    const files = [
      manifestOf({ "@octokit/rest": "22.0.1" }),
      {
        path: "index.ts",
        content: [
          'import { Octokit } from "@octokit/rest";',
          "export default async (input: Input, ctx: Context) => {",
          "  const client = new Octokit({ auth: ctx.proxyKey, baseUrl: ctx.proxyBase() });",
          "  return { ok: Boolean(client), name: input.name };",
          "};",
        ].join("\n"),
      },
    ];

    const result = await publish({ name: "issues", draftPath: await draft("job1", files) });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(h.install).toHaveBeenCalledWith({
      toolboxId: TOOLBOX,
      versionPath: "tools/demo/issues/v1",
    });
    expect(result.version.lockfileHash).toBe(
      sha256Hex('{"lockfileVersion":3,"for":"tools/demo/issues/v1"}'),
    );
    // The version's manifest says it is an ES module, so a run prints no detection warning; the
    // source hash is over the files as written.
    const manifest = await h.store.read(TOOLBOX, "tools/demo/issues/v1/package.json");
    expect(JSON.parse(manifest)).toEqual({
      type: "module",
      dependencies: { "@octokit/rest": "22.0.1" },
    });
    expect(manifest.startsWith('{\n  "type": "module",')).toBe(true);
    expect(result.version.sourceHash).toBe(
      sourceHashOf([
        { path: "package.json", content: manifest },
        ...files.filter((f) => f.path !== "package.json"),
      ]),
    );
    expect(result.dependencies).toEqual(["@octokit/rest"]);
    // Allowlisted: the registry was never asked.
    expect(h.metadata.lookups).toEqual([]);
    expect(
      await h.store.exists(TOOLBOX, "tools/demo/issues/v1/node_modules/left-pad/index.js"),
    ).toBe(true);
  });

  it("admits a package the registry vouches for, asking once per package", async () => {
    h.metadata = createFakeMetadataSource({ "left-pad@1.3.0": ADMITTED });
    h.deps.metadata = h.metadata;

    const result = await publish({
      name: "pad",
      inputSchema: PAD_SCHEMA,
      draftPath: await draft("job1", await readFixture("left-pad")),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(h.metadata.lookups).toEqual(["left-pad@1.3.0"]);
    expect(h.install).toHaveBeenCalledTimes(1);
  });

  it("admits a package through the configured extra names without asking the registry", async () => {
    h.deps.policy = {
      ...DEFAULT_PACKAGE_POLICY,
      allowlist: [...DEFAULT_PACKAGE_POLICY.allowlist, "left-pad"],
    };

    const result = await publish({
      name: "pad",
      inputSchema: PAD_SCHEMA,
      draftPath: await draft("job1", await readFixture("left-pad")),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(h.metadata.lookups).toEqual([]);
  });

  it.each([
    ["exact-version", "left-pad", "^1.3.0", null],
    ["unknown-package", "left-pad-typo", "1.0.0", null],
    ["provenance", "left-pad", "1.3.0", { ...ADMITTED, hasProvenance: false }],
    ["age", "left-pad", "1.3.0", { ...ADMITTED, publishedAt: new Date("2026-09-01T00:00:00Z") }],
    ["downloads", "left-pad", "1.3.0", { ...ADMITTED, weeklyDownloads: 12 }],
  ] as const)(
    "refuses a package failing the %s rule with a diagnostic naming the package and the rule, and writes no version",
    async (rule, name, version, metadata) => {
      h.metadata = createFakeMetadataSource({ [`${name}@${version}`]: metadata });
      h.deps.metadata = h.metadata;
      const files = [
        manifestOf({ [name]: version }),
        {
          path: "index.ts",
          content: `import dep from "${name}";\nexport default async (input: Input, ctx: Context) => ({ dep, name: input.name });`,
        },
      ];

      const result = await publish({ name: "pad", draftPath: await draft("job1", files) });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals).toEqual([
        expect.objectContaining({
          rule: "package-policy",
          file: "package.json",
          line: 3,
          column: 5,
          text: `"${name}": "${version}"`,
          message: expect.stringContaining(`${name}@${version} fails the package policy (${rule})`),
          policy: { package: name, version, rule },
        }),
      ]);
      expect(result.refusals[0]?.hint).toContain(rule === "exact-version" ? "Pin" : "ctx.fetch");
      // The check ran and passed; its advice and annotations still come back.
      expect(result.annotations).toEqual({ readOnly: true, destructive: false });

      expect(await h.store.exists(TOOLBOX, "tools")).toBe(false);
      expect(h.tool.tools).toEqual([]);
      expect(h.tool.versions).toEqual([]);
      expect(h.install).not.toHaveBeenCalled();
      // The registry is asked only where it could change the verdict: not for a range.
      expect(h.metadata.lookups).toEqual(rule === "exact-version" ? [] : [`${name}@${version}`]);
    },
  );

  it("reports every failing package at once", async () => {
    h.metadata = createFakeMetadataSource({
      "left-pad@1.3.0": { ...ADMITTED, hasProvenance: false },
    });
    h.deps.metadata = h.metadata;
    const files = [
      manifestOf({ "left-pad": "1.3.0", "@slack/web-api": "^7.0.0", "@octokit/rest": "22.0.1" }),
      {
        path: "index.ts",
        content:
          'import a from "left-pad";\nimport { WebClient } from "@slack/web-api";\nimport { Octokit } from "@octokit/rest";\nexport default async (input: Input, ctx: Context) => ({ a, WebClient, Octokit, name: input.name });',
      },
    ];

    const result = await publish({ name: "pad", draftPath: await draft("job1", files) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((r) => r.policy)).toEqual([
      { package: "@slack/web-api", version: "^7.0.0", rule: "exact-version" },
      { package: "left-pad", version: "1.3.0", rule: "provenance" },
    ]);
  });

  it("refuses with registry-unavailable, not a policy verdict, when the registry cannot be asked", async () => {
    h.metadata = createFakeMetadataSource({ "left-pad": new Error("ECONNRESET") });
    h.deps.metadata = h.metadata;

    const result = await publish({
      name: "pad",
      inputSchema: PAD_SCHEMA,
      draftPath: await draft("job1", await readFixture("left-pad")),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "registry-unavailable",
        file: "package.json",
        message: expect.stringContaining("ECONNRESET"),
        hint: expect.stringContaining("again"),
      }),
    ]);
    expect(await h.store.exists(TOOLBOX, "tools")).toBe(false);
  });

  it("refuses with install-failed carrying npm's words when the build step fails, records no row, and the next publish lands the same version", async () => {
    h.deps.policy = { ...DEFAULT_PACKAGE_POLICY, allowlist: ["left-pad"] };
    h.install.mockResolvedValueOnce({
      status: "failed",
      exitCode: 1,
      logs: "npm error 404 Not Found - GET https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      stdout: "",
      stderr:
        "npm error 404 Not Found - GET https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
    });
    const files = await readFixture("left-pad");

    const failed = await publish({
      name: "pad",
      inputSchema: PAD_SCHEMA,
      draftPath: await draft("job1", files),
    });

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.refusals).toEqual([
      expect.objectContaining({
        rule: "install-failed",
        file: "package.json",
        message: expect.stringContaining("failed (exit code 1): npm error 404 Not Found"),
      }),
    ]);
    expect(h.tool.versions).toEqual([]);
    expect(h.tool.tools).toEqual([]);
    // The directory was written before the install and stays; nothing under tools/ is removed.
    expect(await h.store.exists(TOOLBOX, "tools/demo/pad/v1/index.ts")).toBe(true);

    const retried = await publish({
      name: "pad",
      inputSchema: PAD_SCHEMA,
      draftPath: await draft("job2", files),
      jobId: "job2",
    });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(retried.ok && retried.version.path).toBe("tools/demo/pad/v1");
    expect(h.install).toHaveBeenCalledTimes(2);
  });

  it("refuses when the install reports success but left no lockfile", async () => {
    h.deps.policy = { ...DEFAULT_PACKAGE_POLICY, allowlist: ["left-pad"] };
    h.deps.sandbox = { install: h.sandbox.install };

    const result = await publish({
      name: "pad",
      inputSchema: PAD_SCHEMA,
      draftPath: await draft("job1", await readFixture("left-pad")),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0]).toMatchObject({
      rule: "install-failed",
      message: expect.stringContaining("left no package-lock.json"),
    });
  });
});

describe("what is refused before anything is written", () => {
  it("a draft that is not there", async () => {
    const result = await publish({ draftPath: ".drafts/nowhere" });
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ rule: "draft-missing", file: ".drafts/nowhere" }],
      annotations: { readOnly: false, destructive: true },
    });
  });

  it("a draft carrying a lockfile, an npmrc or a node_modules", async () => {
    const result = await publish({
      draftPath: await draft("job1", [
        ...(await readFixture("hello")),
        { path: "package-lock.json", content: "{}" },
        { path: "node_modules/x/index.js", content: "" },
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The store hands the draft back sorted by path, and the refusals follow that order.
    expect(result.refusals.map((r) => [r.rule, r.file])).toEqual([
      ["draft-contents", "node_modules/x/index.js"],
      ["draft-contents", "package-lock.json"],
    ]);
    expect(await h.store.exists(TOOLBOX, "tools")).toBe(false);
  });

  it("a manifest declaring packages anywhere but dependencies", async () => {
    const result = await publish({
      draftPath: await draft("job1", [
        ...(await readFixture("hello")),
        { path: "package.json", content: '{\n  "devDependencies": { "left-pad": "1.3.0" }\n}' },
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals).toEqual([
      expect.objectContaining({
        rule: "manifest-invalid",
        line: 2,
        message: expect.stringContaining("devDependencies"),
      }),
    ]);
  });

  it("a module the check refuses, with the check's diagnostics and nothing written", async () => {
    const result = await publish({
      draftPath: await draft("job1", [
        {
          path: "index.ts",
          content:
            'export default async (input: Input, ctx: Context) => ({ ok: (await ctx.fetch("https://api.example/greetings")).ok, name: input.name });',
        },
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((r) => r.rule)).toEqual(["fetch-absolute-url"]);
    expect(result.refusals[0]).toMatchObject({ file: "index.ts", line: 1 });
    expect(await h.store.exists(TOOLBOX, "tools")).toBe(false);
    expect(h.tool.tools).toEqual([]);
  });

  it("a package the module imports but does not declare — the check's vendored-import rule", async () => {
    const result = await publish({
      name: "pad",
      inputSchema: PAD_SCHEMA,
      draftPath: await draft(
        "job1",
        (await readFixture("left-pad")).filter((file) => file.path !== "package.json"),
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((r) => r.rule)).toEqual(["import-not-vendored"]);
  });

  it("a bad definition is BAD_REQUEST before the store is read", async () => {
    const store = { ...h.store, exists: vi.fn(h.store.exists) };
    h.deps.store = store;
    for (const bad of [
      { name: "Hello" },
      { vendor: "Demo" },
      { description: "" },
      { inputSchema: { type: "string" } },
    ]) {
      await expect(publish({ draftPath: ".drafts/job1", ...bad })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    await expect(publish({ draftPath: "/abs" })).rejects.toThrow(/toolbox path/);
    expect(store.exists).not.toHaveBeenCalled();
  });
});

describe("the mirror", () => {
  it("is called with the version after the publish has answered, and its outcome is reported off the path", async () => {
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const calls: string[] = [];
    h.deps.mirror = {
      mirrorVersion: async (_toolboxId, versionPath) => {
        await gate;
        calls.push(versionPath);
      },
    };

    const result = await publish({ draftPath: await draft("job1", await readFixture("hello")) });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    released();
    await vi.waitFor(() => expect(calls).toEqual(["tools/demo/hello/v1"]));
    await vi.waitFor(() => expect(h.mirrorEvents).toHaveLength(1));
    expect(h.mirrorEvents[0]).toMatchObject({
      outcome: "mirrored",
      personId: PERSON,
      agentId: "agent1",
      toolboxId: TOOLBOX,
      versionPath: "tools/demo/hello/v1",
      toolId: result.ok ? result.tool.id : "",
      versionId: result.ok ? result.version.id : "",
    });
  });

  it("that rejects, or throws, never fails the publish, and is one failed event with the cause", async () => {
    h.deps.mirror = {
      mirrorVersion: () =>
        Promise.reject(new Error("bucket unreachable", { cause: new Error("ETIMEDOUT") })),
    };
    const rejected = await publish({ draftPath: await draft("job1", await readFixture("hello")) });
    expect(rejected.ok).toBe(true);
    await vi.waitFor(() => expect(h.mirrorEvents).toHaveLength(1));
    expect(h.mirrorEvents[0]).toMatchObject({
      outcome: "failed",
      cause: "bucket unreachable ← ETIMEDOUT",
    });

    h.deps.mirror = {
      mirrorVersion: () => {
        throw new Error("synchronous");
      },
    };
    const thrown = await publish({
      name: "other",
      draftPath: await draft("job2", await readFixture("hello")),
    });
    expect(thrown.ok).toBe(true);
    await vi.waitFor(() => expect(h.mirrorEvents).toHaveLength(2));
    expect(h.mirrorEvents[1]).toMatchObject({ outcome: "failed", cause: "synchronous" });
  });

  it("a reporter that throws is swallowed", async () => {
    h.deps.onMirror = () => {
      throw new Error("reporter down");
    };
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    const result = await publish({ draftPath: await draft("job1", await readFixture("hello")) });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(h.mirror.calls).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });
});
