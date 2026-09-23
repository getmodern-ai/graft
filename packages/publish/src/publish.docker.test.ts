import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkModule } from "@graft/check";
import {
  readRunnerEnvelope,
  runnerFiles,
  runnerPath,
  runnerSeedDir,
} from "@graft/runner/runner-source";
import { fetchProbe } from "@graft/sandbox/conformance";
import {
  createDockerSandboxBackend,
  DockerEngine,
  DockerEngineError,
  type DockerSandboxBackend,
  ensureInternalNetwork,
  removeNetwork,
  resolveDockerHost,
} from "@graft/sandbox-docker";
import {
  createFilesystemToolboxStore,
  createNoopToolboxMirror,
  type FilesystemToolboxStore,
  sandboxPath,
  TOOLBOX_MOUNT_PATH,
  type ToolboxFile,
} from "@graft/toolbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "./hash";
import { createFakeMetadataSource } from "./metadata";
import { DEFAULT_PACKAGE_POLICY } from "./policy";
import { publishToolVersion } from "./publish.service";
import { createInMemoryToolDeps, fakeDb } from "./testing";

/**
 * The publish against the Docker backing — the one integration test GRA-18 owes (ADR 0013): a
 * module declaring `left-pad@1.3.0` is published through the filesystem store with the Docker
 * backing's install step vendoring the package into the version, then run offline in a sandbox
 * through `runner.mjs`, which imports the vendored copy while the sandbox has no route to the
 * registry. The store and the sandbox meet through the backing's `toolboxHostRoot`: the toolbox
 * volume is a bind of the store's directory (`@graft/toolbox`'s README).
 *
 * Without a daemon the file skips and says so; under `CI` it fails instead, as the sandbox
 * conformance suite does, because a CI run that silently skipped this would be a green with nothing
 * behind ADR 0013's acceptance criterion. `GRAFT_SANDBOX_IMAGE` names a prebuilt image (CI builds
 * one); unset, `graft-sandbox:dev` is built from `@graft/sandbox-docker`'s Dockerfile when missing.
 */

const DEFAULT_IMAGE = "graft-sandbox:dev";
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const PERSON = "person1";

async function probeDocker(): Promise<
  { engine: DockerEngine; reason?: undefined } | { engine?: undefined; reason: string }
> {
  let engine: DockerEngine;
  try {
    engine = new DockerEngine(resolveDockerHost(process.env.DOCKER_HOST));
  } catch (error) {
    return { reason: (error as Error).message };
  }
  if (await engine.ping()) return { engine };
  return { reason: `no daemon answered at ${process.env.DOCKER_HOST ?? "the default socket"}` };
}

const docker = await probeDocker();
if (docker.reason) {
  if (process.env.CI) {
    throw new Error(
      `skipped: no Docker (${docker.reason}) — refused under CI, where this suite is the point`,
    );
  }
  process.stderr.write(`skipped: no Docker (${docker.reason})\n`);
}

async function imageExists(engine: DockerEngine, image: string): Promise<boolean> {
  try {
    await engine.json("GET", `/images/${encodeURIComponent(image)}/json`);
    return true;
  } catch (error) {
    if (error instanceof DockerEngineError && error.status === 404) return false;
    throw error;
  }
}

/** The image under test: the one named, or `graft-sandbox:dev` built from the backing's Dockerfile when missing. */
async function resolveImage(engine: DockerEngine): Promise<string> {
  const named = process.env.GRAFT_SANDBOX_IMAGE;
  if (named) {
    if (!(await imageExists(engine, named))) {
      throw new Error(`GRAFT_SANDBOX_IMAGE=${named} names an image the daemon does not have`);
    }
    return named;
  }
  if (!(await imageExists(engine, DEFAULT_IMAGE))) {
    const context = fileURLToPath(new URL("../../sandbox-docker/", import.meta.url));
    console.warn(
      `building ${DEFAULT_IMAGE} from ${context} (set GRAFT_SANDBOX_IMAGE to use a prebuilt one)`,
    );
    await promisify(execFile)("docker", ["build", "-t", DEFAULT_IMAGE, context], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return DEFAULT_IMAGE;
}

async function readFixture(name: string): Promise<ToolboxFile[]> {
  const dir = join(FIXTURES, name);
  const names = (await readdir(dir)).filter((file) => file !== "schema.json").sort();
  return Promise.all(
    names.map(async (file) => ({ path: file, content: await readFile(join(dir, file), "utf8") })),
  );
}

type Fixture = {
  root: string;
  store: FilesystemToolboxStore;
  backend: DockerSandboxBackend;
  network: string;
  engine: DockerEngine;
  close: () => Promise<void>;
};

async function makeFixture(engine: DockerEngine): Promise<Fixture> {
  const run = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const image = await resolveImage(engine);
  const network = `graft-publish-${run}`;
  const prefix = `graft-publish-${run}`;
  // The store's root is also every toolbox volume's bind — the two halves of one tree.
  const root = mkdtempSync(join(tmpdir(), "graft-publish-"));
  await ensureInternalNetwork(engine, network);
  const backend = createDockerSandboxBackend({
    image,
    network,
    prefix,
    toolboxVolumePrefix: `${prefix}-toolbox`,
    toolboxHostRoot: root,
  });
  const store = createFilesystemToolboxStore({ root });
  return {
    root,
    store,
    backend,
    network,
    engine,
    close: async () => {
      // What the install step and the sandbox wrote belongs to the sandbox user; on a Linux host
      // this process may not remove it, so a sandbox removes what it owns first and the host
      // removal is best-effort. A leftover under the temp directory is litter, not a failure.
      try {
        const { handle } = await backend.ensure({ name: "cleanup" });
        await handle.mountToolbox({ toolboxId: PERSON, mountPath: TOOLBOX_MOUNT_PATH });
        await handle.exec(`rm -rf ${TOOLBOX_MOUNT_PATH}/tools/*/*/v*/* 2>/dev/null; true`);
      } catch {
        // The cleanup sandbox is a courtesy.
      }
      for (const sandbox of await backend.list()) await backend.destroy(sandbox.name);
      await backend.removeToolboxVolumes();
      await removeNetwork(engine, network);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

describe.skipIf(docker.reason !== undefined)("the publish against the Docker backing", () => {
  const engine = docker.engine as DockerEngine;
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture(engine);
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it("vendors an allowlisted package into the version and a sandbox runs it offline, with no route to the registry", async () => {
    const { store, backend } = fixture;
    const tool = createInMemoryToolDeps();
    await store.writeTree(PERSON, ".drafts/job1", await readFixture("left-pad"));

    const result = await publishToolVersion(
      {
        db: fakeDb,
        store,
        mirror: createNoopToolboxMirror(),
        sandbox: backend,
        metadata: createFakeMetadataSource({}),
        // `left-pad` is not an official SDK; the extra-names option is how a deployment admits one.
        policy: {
          ...DEFAULT_PACKAGE_POLICY,
          allowlist: [...DEFAULT_PACKAGE_POLICY.allowlist, "left-pad"],
        },
        tool,
        check: checkModule,
        now: () => new Date(),
        onMirror: () => undefined,
      },
      {
        personId: PERSON,
        toolboxId: PERSON,
        vendor: "demo",
        name: "pad",
        description: "Pads a word on the left",
        inputSchema: {
          type: "object",
          properties: { word: { type: "string" }, width: { type: "integer" } },
          required: ["word", "width"],
        },
        draftPath: ".drafts/job1",
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.version.path).toBe("tools/demo/pad/v1");
    expect(result.dependencies).toEqual(["left-pad"]);

    // The version carries its own node_modules and lockfile, and the row's hash is the lockfile's.
    const lockfile = await store.read(PERSON, "tools/demo/pad/v1/package-lock.json");
    expect(lockfile).toContain('"left-pad"');
    expect(result.version.lockfileHash).toBe(sha256Hex(lockfile));
    expect(await store.exists(PERSON, "tools/demo/pad/v1/node_modules/left-pad/index.js")).toBe(
      true,
    );
    expect(await store.list(PERSON, "tools/demo/pad/v1")).toEqual([
      "index.ts",
      "node_modules",
      "package-lock.json",
      "package.json",
    ]);

    // A run: the toolbox mounted first, the runner seeded, the module imported from the version.
    const { handle } = await backend.ensure({ name: "run" });
    await handle.mountToolbox({ toolboxId: PERSON, mountPath: TOOLBOX_MOUNT_PATH });
    // Seeded by hand under a stand-in hash: this suite has no MCP deps to compute the real one.
    await handle.writeTree(await runnerFiles(), runnerSeedDir("test"));
    const modulePath = sandboxPath(result.version.path);
    expect(modulePath).toBe("/tools/tools/demo/pad/v1");
    const output = await handle.exec(
      `printf '%s' '{"word":"x","width":3}' | node ${runnerPath("test")} ${modulePath}`,
      { timeoutSeconds: 60 },
    );
    // The runner's envelope (GRA-186): the module's result beside the ledger of blobs it wrote, none here.
    expect(readRunnerEnvelope(output)).toEqual({
      result: { padded: "--x" },
      blobs: [],
      dropped: 0,
    });

    // And that sandbox has no route to the registry: the vendored copy is the only one it could load.
    expect(await handle.exec(fetchProbe("https://registry.npmjs.org/left-pad"))).toMatch(/^failed/);
    expect(await handle.exec("command -v npm; echo exit=$?")).toMatch(/exit=(1|127)$/);
  });
});
