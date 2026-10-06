import { posix } from "node:path";

import type { AgentScope } from "@graft/core";
import {
  RUNNER_DIR,
  RUNNER_FILE,
  RUNNER_PATH_VARIABLE,
  type RunnerFile,
  runnerPath,
  runnerSeedDir,
  type Skill,
} from "@graft/runner";
import { createFakeSandboxBackend, type SandboxBackend, type SandboxHandle } from "@graft/sandbox";
import { afterEach, describe, expect, it } from "vitest";

import {
  commandEnvironment,
  errorMessage,
  isPolledProcess,
  openAgentSandbox,
  runnerPathIn,
  type SandboxDeps,
  seedDigest,
  seededRunnerPath,
} from "./sandbox";

/**
 * The one spelling of "a runner answer with its ledger" (GRA-200): what `runCommand` and
 * `pollProcess` return, as against the two other things a call path holds at that point, which
 * `tools/execute.ts`, `tools/authoring.ts` and `in-flight.ts` each tell apart with this.
 */
describe("isPolledProcess", () => {
  it("is a polled process with an answer and a ledger, empty ledger included", () => {
    expect(isPolledProcess({ answer: { exitCode: 0, output: "" }, blobs: [], dropped: 0 })).toBe(
      true,
    );
    expect(
      isPolledProcess({
        answer: { status: "running", processName: "cmd-1", timeoutSeconds: 60 },
        blobs: [{ ref: "blob://x", bytes: 1, contentType: "text/plain", expiresAt: "" }],
        dropped: 0,
      }),
    ).toBe(true);
  });

  it("is not withSandbox's failure, a refusal, a bare answer, or nothing", () => {
    expect(isPolledProcess({ error: "The sandbox is unavailable right now: no daemon" })).toBe(
      false,
    );
    expect(isPolledProcess({ error: "refused", reason: "blob_quota", message: "" })).toBe(false);
    // A detached start on its own, as `describeDetachedStart` answers it, is not the wrapped shape.
    expect(isPolledProcess({ status: "running", processName: "cmd-1", timeoutSeconds: 60 })).toBe(
      false,
    );
    // The two halves alone: an answer with no ledger, a ledger with no answer.
    expect(isPolledProcess({ answer: { exitCode: 0 } })).toBe(false);
    expect(isPolledProcess({ answer: "done", blobs: [] })).toBe(false);
    expect(isPolledProcess({ blobs: [], dropped: 0 })).toBe(false);
    expect(isPolledProcess(null)).toBe(false);
    expect(isPolledProcess(undefined)).toBe(false);
    expect(isPolledProcess("answer")).toBe(false);
  });
});

describe("errorMessage", () => {
  it("is an Error's message, then each cause as name [code]: message", () => {
    expect(errorMessage(new Error("the mount failed"))).toBe("the mount failed");
    expect(errorMessage(new Error("the mount failed", { cause: new Error("ECONNRESET") }))).toBe(
      "the mount failed (caused by Error: ECONNRESET)",
    );
  });

  it("walks a chain three deep and names every code — what fetch failed loses on its own", () => {
    // undici's shape, verbatim: the TypeError says nothing, the host and ENOTFOUND are two down.
    const thrown = new Error("the toolbox could not be mounted", {
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND drives.blaxel.example"), {
          code: "ENOTFOUND",
        }),
      }),
    });

    expect(errorMessage(thrown)).toBe(
      "the toolbox could not be mounted (caused by TypeError: fetch failed <- Error [ENOTFOUND]: getaddrinfo ENOTFOUND drives.blaxel.example)",
    );
  });

  it("names the thrown Error's own code, and a cause's only when it is a string", () => {
    const own = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2375"), {
      code: "ECONNREFUSED",
    });
    expect(errorMessage(own)).toBe("connect ECONNREFUSED 127.0.0.1:2375 [ECONNREFUSED]");

    const numbered = new Error("outer", {
      cause: Object.assign(new Error("inner"), { code: 500 }),
    });
    expect(errorMessage(numbered)).toBe("outer (caused by Error: inner)");
  });

  it("reads a plain-object cause the way it reads a thrown plain object", () => {
    const thrown = new Error("the drive call was refused", {
      cause: { code: 403, error: "Drives feature is not enabled for this workspace" },
    });

    expect(errorMessage(thrown)).toBe(
      "the drive call was refused (caused by Drives feature is not enabled for this workspace (403))",
    );
  });

  it("stops at the proxy's cap and says so", () => {
    let deepest = new Error("link 0");
    for (let i = 1; i < 20; i++) deepest = new Error(`link ${i}`, { cause: deepest });

    expect(errorMessage(deepest)).toBe(
      "link 19 (caused by Error: link 18 <- Error: link 17 <- Error: link 16 <- Error: link 15 <- ...)",
    );
  });

  it("reads the sentence out of a provider SDK's error body rather than printing [object Object]", () => {
    // The body @blaxel/core throws for a refused drive call, verbatim — what one hosted job could
    // only report as "The sandbox is unavailable: [object Object]".
    expect(
      errorMessage({ code: 403, error: "Drives feature is not enabled for this workspace" }),
    ).toBe("Drives feature is not enabled for this workspace (403)");
    expect(errorMessage({ code: 401, error: "Unauthorized" })).toBe("Unauthorized (401)");
    expect(errorMessage({ message: "not found", status: "404" })).toBe("not found (404)");
    expect(errorMessage({ message: "plain" })).toBe("plain");
  });

  it("falls back to the JSON of a body with no sentence in it, and to String for the rest", () => {
    expect(errorMessage({ code: 500 })).toBe('{"code":500}');
    expect(errorMessage("a string")).toBe("a string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

/**
 * The seed is content-addressed (GRA-193; ADR 0013 as corrected, ADR 0023): a sandbox is one per
 * agent and never destroyed, so each server seeds the runner and the skills under `/graft/<hash>/`
 * when that directory is absent and runs from it, and two servers never write one path. Asserted
 * through what a handle is asked to write, over the fake backing.
 */
describe("openAgentSandbox seeds the runner and the skills under a directory named by their content hash", () => {
  const SCOPE = { agentId: "agent_seed", personId: "person_seed" } as AgentScope;
  const SANDBOX = "agent-agent_seed";
  const RUNNER_V1: RunnerFile[] = [{ path: RUNNER_FILE, content: "// runner v1\n" }];
  const RUNNER_V2: RunnerFile[] = [{ path: RUNNER_FILE, content: "// runner v2: ctx.blob\n" }];
  const SKILLS: Skill[] = [
    { name: "authoring", description: "How to write a module.", content: "Write it." },
  ];
  const SKILLS_CHANGED: Skill[] = [
    { name: "authoring", description: "How to write a module.", content: "Write it well." },
  ];
  const HASH = /^[0-9a-f]{64}$/;

  type Written = { destination: string; paths: string[] };

  /** The fake backing with every `writeTree` on every handle recorded, so "not written again" is observable. */
  function recordingBackend() {
    const fake = createFakeSandboxBackend();
    const writes: Written[] = [];
    const backend: SandboxBackend = {
      ...fake,
      ensure: async (args) => {
        const { handle, existed } = await fake.ensure(args);
        const recording: SandboxHandle = {
          ...handle,
          writeTree: async (files, destination) => {
            writes.push({ destination, paths: files.map((file) => file.path) });
            await handle.writeTree(files, destination);
          },
        };
        return { handle: recording, existed };
      },
    };
    return { fake, backend, writes };
  }

  function depsWith(
    backend: SandboxBackend,
    runner: RunnerFile[],
    skills: Skill[] = SKILLS,
  ): SandboxDeps {
    return {
      sandbox: backend,
      runnerFiles: async () => runner,
      skills: async () => skills,
    };
  }

  let fake: ReturnType<typeof createFakeSandboxBackend> | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("seeds a fresh sandbox under /graft/<hash>/ in one write, the skills before the runner, and writes nothing on a second open", async () => {
    const recorded = recordingBackend();
    fake = recorded.fake;
    const deps = depsWith(recorded.backend, RUNNER_V1);

    const handle = await openAgentSandbox(deps, SCOPE);

    const runner = await seededRunnerPath(deps);
    const directory = posix.dirname(runner);
    expect(directory).toMatch(/^\/graft\/[0-9a-f]{64}$/);
    expect(runner).toBe(`${directory}/${RUNNER_FILE}`);
    expect(recorded.writes).toEqual([
      { destination: directory, paths: ["skills/authoring/SKILL.md", RUNNER_FILE] },
    ]);
    expect(await handle.read(runner)).toBe("// runner v1\n");
    expect(await handle.read(`${directory}/skills/authoring/SKILL.md`)).toContain("Write it.");

    await openAgentSandbox(deps, SCOPE);
    await openAgentSandbox(deps, SCOPE);
    expect(recorded.writes).toHaveLength(1);
  });

  it("an older runner at the fixed path /graft/runner.mjs is left as it is, and the server's lands beside it", async () => {
    const recorded = recordingBackend();
    fake = recorded.fake;
    // What a server before GRA-193 left: the runner at `/graft/runner.mjs`.
    const { handle } = await recorded.fake.ensure({ name: SANDBOX });
    await handle.writeTree(RUNNER_V1, RUNNER_DIR);
    const deps = depsWith(recorded.backend, RUNNER_V2);

    await openAgentSandbox(deps, SCOPE);

    const runner = await seededRunnerPath(deps);
    expect(await handle.read(runner)).toBe("// runner v2: ctx.blob\n");
    expect(await handle.read(`${RUNNER_DIR}/${RUNNER_FILE}`)).toBe("// runner v1\n");
    expect(recorded.writes).toEqual([
      { destination: posix.dirname(runner), paths: ["skills/authoring/SKILL.md", RUNNER_FILE] },
    ]);

    await openAgentSandbox(deps, SCOPE);
    expect(recorded.writes).toHaveLength(1);
  });

  it("two servers sharing one sandbox each seed their own directory once and each run from their own", async () => {
    const recorded = recordingBackend();
    fake = recorded.fake;
    const older = depsWith(recorded.backend, RUNNER_V1);
    const newer = depsWith(recorded.backend, RUNNER_V2);

    const handle = await openAgentSandbox(older, SCOPE);
    await openAgentSandbox(newer, SCOPE);
    // A rolling deploy: the older server opens the sandbox again after the newer one seeded it.
    await openAgentSandbox(older, SCOPE);
    await openAgentSandbox(newer, SCOPE);

    const olderRunner = await seededRunnerPath(older);
    const newerRunner = await seededRunnerPath(newer);
    expect(olderRunner).not.toBe(newerRunner);
    expect(await handle.read(olderRunner)).toBe("// runner v1\n");
    expect(await handle.read(newerRunner)).toBe("// runner v2: ctx.blob\n");
    expect(recorded.writes.map((write) => write.destination)).toEqual([
      posix.dirname(olderRunner),
      posix.dirname(newerRunner),
    ]);
  });

  it("the same runner with a changed skill is another seed, in another directory", async () => {
    const recorded = recordingBackend();
    fake = recorded.fake;
    const deps = depsWith(recorded.backend, RUNNER_V2);
    const changed = depsWith(recorded.backend, RUNNER_V2, SKILLS_CHANGED);

    const handle = await openAgentSandbox(deps, SCOPE);
    await openAgentSandbox(changed, SCOPE);

    const before = await seededRunnerPath(deps);
    const after = await seededRunnerPath(changed);
    expect(after).not.toBe(before);
    expect(await handle.read(`${posix.dirname(before)}/skills/authoring/SKILL.md`)).toContain(
      "Write it.",
    );
    expect(await handle.read(`${posix.dirname(after)}/skills/authoring/SKILL.md`)).toContain(
      "Write it well.",
    );
    expect(recorded.writes).toHaveLength(2);
  });

  it("the digest is over the paths inside the seed and the bytes, in a fixed order, and names the directory", () => {
    const a = seedDigest([
      { path: "runner.mjs", content: "x" },
      { path: "skills/s/SKILL.md", content: "y" },
    ]);
    const reordered = seedDigest([
      { path: "skills/s/SKILL.md", content: "y" },
      { path: "runner.mjs", content: "x" },
    ]);
    const moved = seedDigest([
      { path: "runner.mjs", content: "x" },
      { path: "skills/t/SKILL.md", content: "y" },
    ]);
    const changed = seedDigest([
      { path: "runner.mjs", content: "x " },
      { path: "skills/s/SKILL.md", content: "y" },
    ]);
    expect(a).toBe(reordered);
    expect(a).not.toBe(moved);
    expect(a).not.toBe(changed);
    expect(a).toMatch(HASH);
    expect(runnerSeedDir(a)).toBe(`/graft/${a}`);
    expect(runnerPath(a)).toBe(`/graft/${a}/runner.mjs`);
  });

  it("a command's environment carries the runner's path as GRAFT_RUNNER, and the run script reads it from there alone", () => {
    const env = commandEnvironment(30, "/graft/abc/runner.mjs");
    expect(env[RUNNER_PATH_VARIABLE]).toBe("/graft/abc/runner.mjs");
    expect(RUNNER_PATH_VARIABLE).toBe("GRAFT_RUNNER");
    expect(runnerPathIn(env)).toBe("/graft/abc/runner.mjs");
    expect(() => runnerPathIn({ GRAFT_TIMEOUT_MS: "1000" })).toThrow(/GRAFT_RUNNER/);
  });
});
