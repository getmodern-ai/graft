import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type ConformanceFixture, sandboxConformance } from "@graft/sandbox/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDockerSandboxBackend,
  type DockerSandboxBackend,
  ensureInternalNetwork,
  removeNetwork,
  SANDBOX_UID,
  SANDBOX_USER,
} from "./backend";
import { DockerEngine, DockerEngineError, demux, resolveDockerHost } from "./engine";

/**
 * The Docker backing against the conformance suite, plus what is true of this backing alone: the
 * image's hygiene, a real install, the network guard.
 *
 * Without a daemon the file skips and says so, so `pnpm run test` on a laptop without Docker stays
 * green; under `CI` it fails instead, because a CI run that silently skipped the one suite the job
 * builds an image for would be a green with nothing behind it. `GRAFT_SANDBOX_IMAGE` names a
 * prebuilt image (CI builds one); unset, the image is built here from this package's `Dockerfile`
 * when it is missing, which is the laptop path.
 */

const DEFAULT_IMAGE = "graft-sandbox:dev";
const PROXY_STUB_PORT = 8080;

/** A stub standing where the proxy will (GRA-5): answers 200 to anything, so a sandbox can prove it got through. */
const PROXY_STUB_SCRIPT = `
require("node:http").createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("proxy stub: " + request.method + " " + request.url);
}).listen(${PROXY_STUB_PORT}, "0.0.0.0");
`;

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
  const where = process.env.DOCKER_HOST ?? "the default socket";
  return { reason: `no daemon answered at ${where}` };
}

const docker = await probeDocker();
if (docker.reason) {
  if (process.env.CI) {
    throw new Error(
      `skipped: no Docker (${docker.reason}) — refused under CI, where this suite is the point`,
    );
  }
  // A raw write, not `console.warn`: vitest swallows console output from a file whose every test is
  // skipped, and the point of this line is to be seen.
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

/** The image under test: the one named, or `graft-sandbox:dev` built here when it is missing. */
async function resolveImage(engine: DockerEngine): Promise<string> {
  const named = process.env.GRAFT_SANDBOX_IMAGE;
  if (named) {
    if (!(await imageExists(engine, named))) {
      throw new Error(`GRAFT_SANDBOX_IMAGE=${named} names an image the daemon does not have`);
    }
    return named;
  }
  if (!(await imageExists(engine, DEFAULT_IMAGE))) {
    const context = fileURLToPath(new URL("..", import.meta.url));
    console.warn(
      `building ${DEFAULT_IMAGE} from ${context} (set GRAFT_SANDBOX_IMAGE to use a prebuilt one)`,
    );
    await promisify(execFile)("docker", ["build", "-t", DEFAULT_IMAGE, context], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return DEFAULT_IMAGE;
}

type Fixture = ConformanceFixture & {
  backend: DockerSandboxBackend;
  image: string;
  network: string;
  prefix: string;
  engine: DockerEngine;
};

/** An internal network with the proxy stub on it, and a backend whose sandboxes join it. */
async function makeFixture(engine: DockerEngine): Promise<Fixture> {
  const run = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const image = await resolveImage(engine);
  const network = `graft-conformance-${run}`;
  const prefix = `graft-conformance-${run}`;
  await ensureInternalNetwork(engine, network);

  const stubName = `${prefix}-proxy-stub`;
  const { Id: stubId } = await engine.json<{ Id: string }>("POST", "/containers/create", {
    query: { name: stubName },
    body: {
      Image: image,
      User: SANDBOX_USER,
      Cmd: ["node", "-e", PROXY_STUB_SCRIPT],
      HostConfig: { NetworkMode: network, Init: true },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ["proxy"] } } },
    },
  });
  await engine.json("POST", `/containers/${stubId}/start`);

  const backend = createDockerSandboxBackend({
    image,
    network,
    prefix,
    toolboxVolumePrefix: `${prefix}-toolbox`,
  });

  return {
    backend,
    image,
    network,
    prefix,
    engine,
    proxyUrl: `http://proxy:${PROXY_STUB_PORT}/ping`,
    close: async () => {
      for (const sandbox of await backend.list()) await backend.destroy(sandbox.name);
      await engine
        .json("DELETE", `/containers/${stubId}`, { query: { force: true } })
        .catch(() => undefined);
      await backend.removeToolboxVolumes();
      await removeNetwork(engine, network);
    },
  };
}

describe.skipIf(docker.reason !== undefined)("docker sandbox backing", () => {
  const engine = docker.engine as DockerEngine;

  sandboxConformance("docker", () => makeFixture(engine));

  describe("docker-specific", () => {
    let fixture: Fixture;
    /** Sandboxes made here are destroyed by the fixture's `close`, which lists the backend's own. */
    const ensure = async (label: string) => {
      const name = `specific-${label}`;
      return (await fixture.backend.ensure({ name })).handle;
    };

    beforeAll(async () => {
      fixture = await makeFixture(engine);
    });

    afterAll(async () => {
      await fixture.close?.();
    });

    it("runs a tool as the sandbox user, in the image's Node 24, from /workspace", async () => {
      const handle = await ensure("user");

      expect(await handle.exec("id -u")).toBe(String(SANDBOX_UID));
      expect(await handle.exec("id -un")).toBe(SANDBOX_USER);
      expect(await handle.exec("pwd")).toBe("/workspace");
      expect(await handle.exec("echo $HOME")).toBe("/home/graft");
      expect(await handle.exec("node --version")).toMatch(/^v24\./);
    });

    it("keeps npm where a tool run cannot enter, and the system package manager nowhere", async () => {
      const handle = await ensure("hygiene");

      expect(await handle.exec("ls /opt/graft 2>&1")).toMatch(/Permission denied/);
      expect(await handle.exec("node /opt/graft/npm/lib/bin/npm-cli.js --version 2>&1")).toMatch(
        /EACCES|Permission denied|Cannot find module/,
      );
      // Nothing found prints nothing; the exit code is 127 under dash and 1 under bash.
      expect(
        await handle.exec("command -v npm npx corepack yarn apt-get dpkg apk; echo exit=$?"),
      ).toMatch(/^exit=(1|127)$/);
      expect(await handle.exec("ls /var/lib/dpkg /etc/apt 2>&1 | grep -c 'No such file'")).toBe(
        "2",
      );
    });

    it("writes files the sandbox user owns and can write beside", async () => {
      const handle = await ensure("ownership");
      await handle.writeTree([{ path: "deep/er/file.txt", content: "x" }], "/graft/new/tree");

      expect(await handle.exec("stat -c '%u %U' /graft/new /graft/new/tree/deep/er/file.txt")).toBe(
        `${SANDBOX_UID} ${SANDBOX_USER}\n${SANDBOX_UID} ${SANDBOX_USER}`,
      );
      expect(
        await handle.exec(
          "echo more > /graft/new/tree/deep/sibling.txt && cat /graft/new/tree/deep/sibling.txt",
        ),
      ).toBe("more");
    });

    it("mounts a toolbox around a running sandbox and reports the same sandbox name afterwards", async () => {
      const name = "specific-remount";
      const { handle } = await fixture.backend.ensure({ name });
      const before = await fixture.engine.json<{ Id: string }>(
        "GET",
        `/containers/${fixture.backend.containerName(name)}/json`,
      );

      await handle.mountToolbox({ toolboxId: "remount", mountPath: "/tools" });
      await handle.writeTree([{ path: "after.txt", content: "after" }], "/tools");

      const after = await fixture.engine.json<{
        Id: string;
        Mounts: { Name?: string; Destination: string }[];
      }>("GET", `/containers/${fixture.backend.containerName(name)}/json`);
      expect(after.Id).not.toBe(before.Id);
      expect(after.Mounts.map((mount) => mount.Destination)).toEqual(["/tools"]);
      expect(await handle.read("/tools/after.txt")).toBe("after");
      expect((await fixture.backend.list()).map((s) => s.name)).toContain(name);
    });

    it("a new toolbox volume is writable by the sandbox user from the first file", async () => {
      const handle = await ensure("fresh-volume");
      await handle.mountToolbox({ toolboxId: "fresh", mountPath: "/tools" });

      expect(
        await handle.exec("echo first > /tools/first.txt && stat -c %u /tools /tools/first.txt"),
      ).toBe(`${SANDBOX_UID}\n${SANDBOX_UID}`);
    });

    it("refuses a shared toolbox volume the daemon does not have, naming it, rather than letting Docker create a second tree", async () => {
      const missing = createDockerSandboxBackend({
        image: fixture.image,
        network: fixture.network,
        prefix: `${fixture.prefix}-missing`,
        toolboxVolume: `${fixture.prefix}-nowhere`,
      });
      try {
        const { handle } = await missing.ensure({ name: "missing-volume" });
        await expect(
          handle.mountToolbox({ toolboxId: "person", mountPath: "/tools" }),
        ).rejects.toThrow(/nowhere does not exist on the daemon.*GRAFT_TOOLBOX_VOLUME/);
        const { Volumes } = await fixture.engine.json<{ Volumes: { Name: string }[] | null }>(
          "GET",
          "/volumes",
        );
        expect((Volumes ?? []).map((v) => v.Name)).not.toContain(`${fixture.prefix}-nowhere`);
      } finally {
        await missing.destroy("missing-volume");
      }
    });

    it("mounts toolboxes as subpaths of one shared volume, each sandbox seeing its own alone, and mounting again is a no-op", async () => {
      const volume = `${fixture.prefix}-shared`;
      await fixture.engine.json("POST", "/volumes/create", { body: { Name: volume } });
      const shared = createDockerSandboxBackend({
        image: fixture.image,
        network: fixture.network,
        prefix: `${fixture.prefix}-shared`,
        toolboxVolume: volume,
      });
      try {
        const a = (await shared.ensure({ name: "shared-a" })).handle;
        const b = (await shared.ensure({ name: "shared-b" })).handle;
        await a.mountToolbox({ toolboxId: "person-a", mountPath: "/tools" });
        await b.mountToolbox({ toolboxId: "person-b", mountPath: "/tools" });
        await a.writeTree([{ path: "mine.txt", content: "a" }], "/tools");
        await b.writeTree([{ path: "mine.txt", content: "b" }], "/tools");

        // Each sees its own file and not the other's, and writes into a directory it owns.
        expect(await a.read("/tools/mine.txt")).toBe("a");
        expect(await b.read("/tools/mine.txt")).toBe("b");
        expect(await a.exec("ls /tools")).toBe("mine.txt");
        expect(await a.exec("stat -c %u /tools")).toBe(String(SANDBOX_UID));

        // The same mount asked for again recreates nothing: the container id is unchanged.
        const before = await fixture.engine.json<{ Id: string }>(
          "GET",
          `/containers/${shared.containerName("shared-a")}/json`,
        );
        await a.mountToolbox({ toolboxId: "person-a", mountPath: "/tools" });
        const after = await fixture.engine.json<{ Id: string }>(
          "GET",
          `/containers/${shared.containerName("shared-a")}/json`,
        );
        expect(after.Id).toBe(before.Id);

        // The volume holds both toolboxes side by side — the tree a server mounting it whole would see.
        const { Id } = await fixture.engine.json<{ Id: string }>("POST", "/containers/create", {
          body: {
            Image: fixture.image,
            Cmd: [
              "sh",
              "-c",
              "ls /toolboxes && cat /toolboxes/person-a/mine.txt /toolboxes/person-b/mine.txt",
            ],
            HostConfig: {
              NetworkMode: fixture.network,
              Mounts: [{ Type: "volume", Source: volume, Target: "/toolboxes" }],
            },
          },
        });
        try {
          await fixture.engine.json("POST", `/containers/${Id}/start`);
          await fixture.engine.json("POST", `/containers/${Id}/wait`);
          const logs = await demux(
            await fixture.engine.stream("GET", `/containers/${Id}/logs`, {
              query: { stdout: true, stderr: true },
            }),
          );
          expect(logs.stdout.split("\n").filter(Boolean)).toEqual(["person-a", "person-b", "ab"]);
        } finally {
          await fixture.engine
            .json("DELETE", `/containers/${Id}`, { query: { force: true } })
            .catch(() => undefined);
        }
      } finally {
        for (const sandbox of await shared.list()) await shared.destroy(sandbox.name);
        await fixture.engine
          .json("DELETE", `/volumes/${volume}`, { query: { force: true } })
          .catch(() => undefined);
      }
    });

    it("install vendors a real dependency into the version directory, lockfile beside it, owned by the sandbox user", async () => {
      const handle = await ensure("install");
      await handle.mountToolbox({ toolboxId: "installs", mountPath: "/tools" });
      await handle.writeTree(
        [
          {
            path: "package.json",
            content: JSON.stringify({
              name: "install-test",
              version: "1.0.0",
              private: true,
              dependencies: { "left-pad": "1.3.0" },
            }),
          },
          {
            path: "index.mjs",
            content: 'import leftPad from "left-pad"; process.stdout.write(leftPad("x", 3, "-"));',
          },
        ],
        "/tools/vendor/tool/v1",
      );

      const result = await fixture.backend.install({
        toolboxId: "installs",
        versionPath: "vendor/tool/v1",
      });

      expect(result.status, result.logs).toBe("completed");
      expect(await handle.ls("/tools/vendor/tool/v1")).toEqual([
        "/tools/vendor/tool/v1/index.mjs",
        "/tools/vendor/tool/v1/node_modules",
        "/tools/vendor/tool/v1/package-lock.json",
        "/tools/vendor/tool/v1/package.json",
      ]);
      expect(await handle.read("/tools/vendor/tool/v1/package-lock.json")).toContain('"left-pad"');
      expect(
        await handle.exec("stat -c %u /tools/vendor/tool/v1/node_modules/left-pad/index.js"),
      ).toBe(String(SANDBOX_UID));
      // The vendored dependency is what the run resolves: no registry, no network, just the directory.
      expect(await handle.exec("node /tools/vendor/tool/v1/index.mjs")).toBe("--x");
    });

    it("install with a lockfile is `npm ci`: a lockfile that disagrees with package.json is a failure the caller can read", async () => {
      const handle = await ensure("install-ci");
      await handle.mountToolbox({ toolboxId: "installs", mountPath: "/tools" });
      await handle.writeTree(
        [
          {
            path: "package.json",
            content: JSON.stringify({
              name: "ci-test",
              version: "1.0.0",
              private: true,
              dependencies: { "left-pad": "1.3.0" },
            }),
          },
          {
            path: "package-lock.json",
            content: JSON.stringify({
              name: "ci-test",
              version: "1.0.0",
              lockfileVersion: 3,
              packages: {},
            }),
          },
        ],
        "/tools/vendor/tool/v2",
      );

      const result = await fixture.backend.install({
        toolboxId: "installs",
        versionPath: "vendor/tool/v2",
      });

      expect(result.status).toBe("failed");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/npm ci|lock/i);
    });

    it("install answers a package that does not exist with a failure, not an exception", async () => {
      const handle = await ensure("install-404");
      await handle.mountToolbox({ toolboxId: "installs", mountPath: "/tools" });
      await handle.writeTree(
        [
          {
            path: "package.json",
            content: JSON.stringify({
              name: "missing-test",
              version: "1.0.0",
              private: true,
              dependencies: { "graft-conformance-package-that-does-not-exist-7f3a": "1.0.0" },
            }),
          },
        ],
        "/tools/vendor/tool/v3",
      );

      const result = await fixture.backend.install({
        toolboxId: "installs",
        versionPath: "vendor/tool/v3",
      });

      expect(result.status).toBe("failed");
      expect(result.stderr).toMatch(/404|E404|Not Found/i);
    });

    it("install of a version directory that is not there is a failure naming it", async () => {
      const result = await fixture.backend.install({
        toolboxId: "installs",
        versionPath: "nowhere/v9",
      });

      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(66);
      expect(result.stderr).toContain("nowhere/v9");
    });

    it("refuses to create a sandbox on a network that is not internal", async () => {
      const onBridge = createDockerSandboxBackend({
        image: fixture.image,
        network: "bridge",
        prefix: `${fixture.prefix}-bridge`,
        install: { network: "none" },
      });

      await expect(onBridge.ensure({ name: "escapee" })).rejects.toThrow(/not internal/);
      expect(await onBridge.list()).toEqual([]);
    });

    it("refuses a network that does not exist, and an install network equal to the sandbox network", async () => {
      const missing = createDockerSandboxBackend({
        image: fixture.image,
        network: `${fixture.network}-does-not-exist`,
        prefix: `${fixture.prefix}-missing`,
      });

      await expect(missing.ensure({ name: "nowhere" })).rejects.toThrow(/does not exist/);
      expect(() =>
        createDockerSandboxBackend({
          image: fixture.image,
          network: fixture.network,
          install: { network: fixture.network },
        }),
      ).toThrow(/install network/);
    });

    it("lists only its own prefix", async () => {
      await ensure("listed");
      const other = createDockerSandboxBackend({
        image: fixture.image,
        network: fixture.network,
        prefix: `${fixture.prefix}-other`,
      });

      expect((await fixture.backend.list()).map((s) => s.name)).toContain("specific-listed");
      expect(await other.list()).toEqual([]);
    });

    it("an exec whose children outlive it still comes back at the deadline", async () => {
      const handle = await ensure("orphans");
      const startedAt = Date.now();

      const output = await handle.exec("(sleep 30 &) ; echo spawned; sleep 30", {
        timeoutSeconds: 1,
      });

      expect(output).toContain("spawned");
      expect(Date.now() - startedAt).toBeLessThan(25_000);
    });
  });
});
