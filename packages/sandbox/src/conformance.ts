import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SandboxBackend, SandboxHandle } from "./types";

/**
 * One suite, every backing. ADR 0002's "exactly two backings per seam" holds only while both answer
 * the same questions, so the questions live here and a backing's own test file does nothing but call
 * `sandboxConformance` with a way to construct itself. A change to the seam lands here first and
 * fails every backing that has not caught up, in the same run.
 *
 * What is asserted is what a service can observe through the seam — output, a status, a file present
 * or absent, a request that succeeded or failed — never how the backing produced it.
 */

export type ConformanceFixture = {
  backend: SandboxBackend;
  /**
   * The backing has no network of its own: the egress assertions are marked not applicable rather
   * than run, and `proxyUrl` is not needed. The fake declares this; a real backing never does, since
   * "the only egress is the proxy" is the property ADR 0013 rests on and the suite exists to check.
   */
  noNetwork?: boolean;
  /** Where the proxy stub answers, as a process inside a sandbox sees it. Required unless `noNetwork`. */
  proxyUrl?: string;
  /** Release whatever the fixture holds beyond the sandboxes, which the suite destroys itself. */
  close?: () => Promise<void>;
};

/** Inside a sandbox: fetch a URL and print one line saying what happened, never throwing. */
export function fetchProbe(url: string): string {
  const script =
    "fetch(process.argv[1], { signal: AbortSignal.timeout(8000) })" +
    ".then((r) => console.log('status', r.status), (e) => console.log('failed', e.cause?.code ?? e.name))";
  return `node -e "${script}" ${shellQuote(url)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The runner's shape: a script that reads all of stdin, computes, and writes JSON to stdout. */
const STDIN_TO_STDOUT_SCRIPT = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input || "{}");
  process.stdout.write(JSON.stringify({ echoed: parsed, doubled: (parsed.n ?? 0) * 2 }));
});
`;

/** Package managers and fetchers a tool run must not find. Each is asked for its version. */
const PROGRAMS_A_TOOL_RUN_MUST_NOT_HAVE = [
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "corepack",
  "apt-get",
  "apk",
  "curl",
  "wget",
];

export function sandboxConformance(
  name: string,
  makeFixture: () => Promise<ConformanceFixture>,
): void {
  describe(`sandbox conformance: ${name}`, () => {
    let fixture: ConformanceFixture;
    /** Unique per run so two suites against one Docker daemon cannot collide on a name. */
    const run = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const created = new Set<string>();
    const sandboxName = (label: string) => `conf-${run}-${label}`;
    const toolboxId = (label: string) => `conf-${run}-${label}`;

    async function ensure(label: string) {
      const name = sandboxName(label);
      created.add(name);
      const { handle, existed } = await fixture.backend.ensure({ name });
      return { name, handle, existed };
    }

    beforeAll(async () => {
      fixture = await makeFixture();
      if (!fixture.noNetwork && !fixture.proxyUrl) {
        throw new Error(
          "a fixture with a network must say where the proxy stub answers (proxyUrl)",
        );
      }
    });

    afterAll(async () => {
      for (const name of created) {
        await fixture.backend.destroy(name).catch(() => undefined);
      }
      await fixture.close?.();
    });

    describe("lifecycle", () => {
      it("creates a sandbox once and finds it again by name", async () => {
        const first = await ensure("life");
        const again = await ensure("life");

        expect(first.existed).toBe(false);
        expect(again.existed).toBe(true);
        expect((await fixture.backend.list()).map((s) => s.name)).toContain(first.name);
      });

      it("a sandbox found again is the same sandbox: a file written through one handle is read through the other", async () => {
        const first = await ensure("same");
        await first.handle.writeTree([{ path: "marker.txt", content: "still here" }], "/workspace");
        const again = await ensure("same");

        expect(await again.handle.read("/workspace/marker.txt")).toBe("still here");
      });

      it("destroy leaves nothing behind, and destroying again is not an error", async () => {
        const { name } = await ensure("gone");

        await fixture.backend.destroy(name);

        expect((await fixture.backend.list()).map((s) => s.name)).not.toContain(name);
        await expect(fixture.backend.destroy(name)).resolves.toBeUndefined();
        expect((await ensure("gone")).existed).toBe(false);
      });

      it("refuses a sandbox name that is not a legal name on every backing", async () => {
        await expect(fixture.backend.ensure({ name: "has space" })).rejects.toThrow(/name/);
        await expect(fixture.backend.ensure({ name: "../escape" })).rejects.toThrow(/name/);
      });
    });

    describe("files", () => {
      const tree = [
        { path: "a.txt", content: "alpha" },
        { path: "sub/b.txt", content: "beta\nwith two lines\n" },
        { path: "sub/deeper/c.json", content: '{"c":3}' },
      ];

      it("writes a tree and reads it back by path", async () => {
        const { handle } = await ensure("files");
        await handle.writeTree(tree, "/workspace/tree");

        expect(await handle.read("/workspace/tree/a.txt")).toBe("alpha");
        expect(await handle.read("/workspace/tree/sub/deeper/c.json")).toBe('{"c":3}');
        expect(await handle.ls("/workspace/tree")).toEqual([
          "/workspace/tree/a.txt",
          "/workspace/tree/sub",
        ]);
      });

      it("downloadDirectory returns exactly what writeTree wrote, sorted by path", async () => {
        const { handle } = await ensure("download");
        await handle.writeTree(tree, "/workspace/out");

        expect(await handle.downloadDirectory("/workspace/out")).toEqual(
          [...tree].sort((a, b) => a.path.localeCompare(b.path)),
        );
        expect(await handle.downloadDirectory("/workspace/out/sub/deeper")).toEqual([
          { path: "c.json", content: '{"c":3}' },
        ]);
      });

      it("a written file is what a process in the sandbox sees", async () => {
        const { handle } = await ensure("visible");
        await handle.writeTree([{ path: "seen.txt", content: "by cat" }], "/workspace");

        expect(await handle.exec("cat /workspace/seen.txt")).toBe("by cat");
      });

      it("read and ls reject for a path that does not exist", async () => {
        const { handle } = await ensure("missing");

        await expect(handle.read("/workspace/nowhere.txt")).rejects.toThrow();
        await expect(handle.ls("/workspace/nowhere")).rejects.toThrow();
      });
    });

    describe("exec", () => {
      let handle: SandboxHandle;
      beforeAll(async () => {
        handle = (await ensure("exec")).handle;
      });

      it("returns the combined output of stdout and stderr, trimmed", async () => {
        const both = await handle.exec("echo out; echo err >&2");
        const padded = await handle.exec("echo '  padded  '");

        // Both streams, in whichever order two pipes delivered them: the order is not the contract.
        expect(both.split("\n").sort()).toEqual(["err", "out"]);
        expect(padded).toBe("padded");
      });

      it("runs where workingDir says", async () => {
        await handle.writeTree([{ path: "here.txt", content: "" }], "/workspace/cwd");

        expect(await handle.exec("ls", { workingDir: "/workspace/cwd" })).toBe("here.txt");
      });

      it("a per-process variable reaches its process and is absent from the next exec on the same sandbox", async () => {
        const withIt = await handle.exec('echo "[$GRAFT_CONFORMANCE_X]"', {
          env: { GRAFT_CONFORMANCE_X: "for-this-process" },
        });
        const without = await handle.exec('echo "[$GRAFT_CONFORMANCE_X]"');

        expect(withIt).toBe("[for-this-process]");
        expect(without).toBe("[]");
      });

      it("a per-process variable is not visible to a detached process started without it", async () => {
        await handle.exec("true", { env: { GRAFT_CONFORMANCE_Y: "sync" } });
        await handle.execDetached('echo "[$GRAFT_CONFORMANCE_Y]"', { name: "env-leak" });

        const result = await handle.waitForProcess("env-leak", {
          maxWaitSeconds: 20,
          pollIntervalMs: 100,
        });

        expect(result.status).toBe("completed");
        expect(result.stdout.trim()).toBe("[]");
      });

      it("node runs a script that reads stdin and writes stdout", async () => {
        await handle.writeTree([{ path: "echo.mjs", content: STDIN_TO_STDOUT_SCRIPT }], "/graft");

        const output = await handle.exec(`echo '{"n":21}' | node /graft/echo.mjs`);

        expect(JSON.parse(output)).toEqual({ echoed: { n: 21 }, doubled: 42 });
        expect(await handle.exec("node --version")).toMatch(/^v24\./);
      });

      it("kills a process at its timeout and comes back", async () => {
        const startedAt = Date.now();

        const output = await handle.exec("echo before; sleep 20; echo after", {
          timeoutSeconds: 1,
        });

        expect(output).toContain("before");
        expect(output).not.toContain("after");
        expect(Date.now() - startedAt).toBeLessThan(15_000);
      });

      it("has no package manager or fetcher reachable from a tool run", async () => {
        for (const program of PROGRAMS_A_TOOL_RUN_MUST_NOT_HAVE) {
          const output = await handle.exec(`${program} --version`);
          // Whatever the backing answers with — "not found", a refusal, an empty line — it is not a
          // version string, which is the one thing a reachable program would print.
          expect(output, `${program} answered with a version`).not.toMatch(/^\d+\.\d+\.\d+/m);
          expect(output, `${program} answered with a version`).not.toMatch(/version \d/i);
        }
      });
    });

    describe("detached", () => {
      let handle: SandboxHandle;
      let name: string;
      beforeAll(async () => {
        const ensured = await ensure("detached");
        handle = ensured.handle;
        name = ensured.name;
      });

      it("a detached exec started by one call is found by name by a later call, with its output and exit code", async () => {
        const returned = await handle.execDetached("echo on stdout; echo on stderr >&2; exit 3", {
          name: "job-exit-3",
        });

        const result = await handle.waitForProcess("job-exit-3", {
          maxWaitSeconds: 20,
          pollIntervalMs: 100,
        });

        expect(returned).toBe("job-exit-3");
        expect(result.status).toBe("failed");
        expect(result.exitCode).toBe(3);
        expect(result.logs).toContain("on stdout");
        expect(result.logs).toContain("on stderr");
        expect(result.stdout.trim()).toBe("on stdout");
        expect(result.stderr.trim()).toBe("on stderr");
      });

      it("a detached exec survives its caller: a wait that runs out reports running with no exit code, and a later wait finds it done", async () => {
        await handle.execDetached("echo started; sleep 2; echo finished", { name: "job-long" });

        const early = await handle.waitForProcess("job-long", {
          maxWaitSeconds: 0.3,
          pollIntervalMs: 100,
        });
        const late = await handle.waitForProcess("job-long", {
          maxWaitSeconds: 20,
          pollIntervalMs: 100,
        });

        expect(early.status).toBe("running");
        expect(early.exitCode).toBeNull();
        expect(late.status).toBe("completed");
        expect(late.exitCode).toBe(0);
        expect(late.stdout).toContain("started");
        expect(late.stdout).toContain("finished");
      });

      it("a detached exec is found through a handle from a later ensure of the same sandbox", async () => {
        await handle.execDetached("echo from the first handle", { name: "job-other-handle" });
        const { handle: later } = await fixture.backend.ensure({ name });

        const result = await later.waitForProcess("job-other-handle", {
          maxWaitSeconds: 20,
          pollIntervalMs: 100,
        });

        expect(result.status).toBe("completed");
        expect(result.stdout.trim()).toBe("from the first handle");
      });

      it("the per-process environment reaches a detached process", async () => {
        await handle.execDetached('echo "[$GRAFT_CONFORMANCE_Z]"', {
          name: "job-env",
          env: { GRAFT_CONFORMANCE_Z: "detached-env" },
        });

        const result = await handle.waitForProcess("job-env", {
          maxWaitSeconds: 20,
          pollIntervalMs: 100,
        });

        expect(result.stdout.trim()).toBe("[detached-env]");
      });

      it("kills a detached exec at its timeout and says so", async () => {
        await handle.execDetached("echo alive; sleep 30", { name: "job-slow", timeoutSeconds: 1 });

        const result = await handle.waitForProcess("job-slow", {
          maxWaitSeconds: 20,
          pollIntervalMs: 100,
        });

        expect(result.status).toBe("killed");
        expect(result.stdout).toContain("alive");
      });

      it("an unknown process name is a failure with no exit code, not an exception", async () => {
        const result = await handle.waitForProcess("never-started", { maxWaitSeconds: 1 });

        expect(result.status).toBe("failed");
        expect(result.exitCode).toBeNull();
        expect(result.logs).toContain("never-started");
      });

      it("refuses a process name that is not a legal name on every backing", async () => {
        await expect(handle.execDetached("true", { name: "has/slash" })).rejects.toThrow(/name/);
      });
    });

    describe("toolbox", () => {
      it("mountToolbox makes a file written in one sandbox visible to a second sandbox of the same toolbox", async () => {
        const toolbox = toolboxId("shared");
        const first = await ensure("toolbox-a");
        const second = await ensure("toolbox-b");
        await first.handle.mountToolbox({ toolboxId: toolbox, mountPath: "/tools" });
        await second.handle.mountToolbox({ toolboxId: toolbox, mountPath: "/tools" });

        await first.handle.writeTree(
          [{ path: "index.mjs", content: "export default () => 'v1';" }],
          "/tools/vendor/tool/v1",
        );

        expect(await second.handle.read("/tools/vendor/tool/v1/index.mjs")).toBe(
          "export default () => 'v1';",
        );
        expect(await second.handle.exec("cat /tools/vendor/tool/v1/index.mjs")).toBe(
          "export default () => 'v1';",
        );
        expect(await second.handle.downloadDirectory("/tools/vendor/tool")).toEqual([
          { path: "v1/index.mjs", content: "export default () => 'v1';" },
        ]);
      });

      it("a file a process writes into the toolbox is there for the next sandbox", async () => {
        const toolbox = toolboxId("written");
        const first = await ensure("toolbox-c");
        await first.handle.mountToolbox({ toolboxId: toolbox, mountPath: "/tools" });
        await first.handle.exec("mkdir -p /tools/drafts && echo 'draft' > /tools/drafts/note.txt");

        const second = await ensure("toolbox-d");
        await second.handle.mountToolbox({ toolboxId: toolbox, mountPath: "/tools" });

        expect(await second.handle.read("/tools/drafts/note.txt")).toBe("draft\n");
      });

      it("mounting the same toolbox at the same path again changes nothing", async () => {
        const toolbox = toolboxId("idempotent");
        const { handle } = await ensure("toolbox-e");
        await handle.mountToolbox({ toolboxId: toolbox, mountPath: "/tools" });
        await handle.writeTree([{ path: "keep.txt", content: "kept" }], "/tools");

        await handle.mountToolbox({ toolboxId: toolbox, mountPath: "/tools" });

        expect(await handle.read("/tools/keep.txt")).toBe("kept");
      });

      it("two toolboxes are two filesystems", async () => {
        const first = await ensure("toolbox-f");
        const second = await ensure("toolbox-g");
        await first.handle.mountToolbox({ toolboxId: toolboxId("one"), mountPath: "/tools" });
        await second.handle.mountToolbox({ toolboxId: toolboxId("two"), mountPath: "/tools" });
        await first.handle.writeTree([{ path: "only-in-one.txt", content: "1" }], "/tools");

        await expect(second.handle.read("/tools/only-in-one.txt")).rejects.toThrow();
      });

      it("install completes for a version that declares no dependencies", async () => {
        const toolbox = toolboxId("install");
        const { handle } = await ensure("toolbox-h");
        await handle.mountToolbox({ toolboxId: toolbox, mountPath: "/tools" });
        await handle.writeTree(
          [
            {
              path: "package.json",
              content: JSON.stringify({
                name: "conformance-tool",
                version: "1.0.0",
                private: true,
              }),
            },
            { path: "index.mjs", content: "export default async () => 'ok';" },
          ],
          "/tools/vendor/tool/v1",
        );

        const result = await fixture.backend.install({
          toolboxId: toolbox,
          versionPath: "vendor/tool/v1",
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        // The install touched nothing but its own outputs: the module is as it was written.
        expect(await handle.read("/tools/vendor/tool/v1/index.mjs")).toBe(
          "export default async () => 'ok';",
        );
      });

      it("install refuses a version path that leaves the toolbox", async () => {
        await expect(
          fixture.backend.install({ toolboxId: toolboxId("escape"), versionPath: "../elsewhere" }),
        ).rejects.toThrow(/versionPath/);
        await expect(
          fixture.backend.install({ toolboxId: toolboxId("escape"), versionPath: "/absolute" }),
        ).rejects.toThrow(/versionPath/);
      });
    });

    describe("egress", () => {
      let handle: SandboxHandle;
      beforeAll(async () => {
        if (fixture.noNetwork) return;
        handle = (await ensure("egress")).handle;
      });

      const NOT_APPLICABLE = "not applicable: the backing declares noNetwork";

      it("a request from inside the sandbox to the proxy stub succeeds", async (ctx) => {
        if (fixture.noNetwork) return ctx.skip(NOT_APPLICABLE);

        expect(await handle.exec(fetchProbe(fixture.proxyUrl ?? ""))).toBe("status 200");
      });

      it("a request to an external IP address fails", async (ctx) => {
        if (fixture.noNetwork) return ctx.skip(NOT_APPLICABLE);

        expect(await handle.exec(fetchProbe("http://1.1.1.1/"))).toMatch(/^failed /);
      });

      it("a request to a public hostname fails", async (ctx) => {
        if (fixture.noNetwork) return ctx.skip(NOT_APPLICABLE);

        expect(await handle.exec(fetchProbe("https://example.com/"))).toMatch(/^failed /);
        expect(await handle.exec(fetchProbe("https://registry.npmjs.org/"))).toMatch(/^failed /);
      });

      it("a detached process is under the same restriction", async (ctx) => {
        if (fixture.noNetwork) return ctx.skip(NOT_APPLICABLE);
        await handle.execDetached(fetchProbe("http://1.1.1.1/"), { name: "egress-detached" });

        const result = await handle.waitForProcess("egress-detached", {
          maxWaitSeconds: 20,
          pollIntervalMs: 100,
        });

        expect(result.stdout.trim()).toMatch(/^failed /);
      });
    });
  });
}
