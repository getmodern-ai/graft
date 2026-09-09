import { posix } from "node:path";

import {
  assertSandboxName,
  assertVersionPath,
  type EnsureSandboxArgs,
  type SandboxBackend,
  type SandboxFile,
  type SandboxHandle,
  type SandboxProcessResult,
  type SandboxSummary,
} from "@graft/sandbox/types";

import { DockerEngine, DockerEngineError, demux, resolveDockerHost } from "./engine";
import { filesUnder, packTree, readTar } from "./tar";

/**
 * The Docker backing of the sandbox seam: the self-hosted form's sandbox (ADR 0002, ADR 0013).
 *
 * One sandbox is one container from the prebuilt image, kept alive by `sleep` and worked through
 * execs; `ensure` creates it on the internal network named in the options, whose only other member is
 * the proxy, so a process inside reaches the proxy by name and nothing else — the daemon gives an
 * internal network no gateway and forwards it no DNS. The toolbox is a named volume mounted where the
 * caller asks. A per-exec environment goes on the exec, so it is that process's alone. A detached
 * exec is a background process whose stdout, stderr and exit code are files under its name, which is
 * how a later call, holding any handle to the sandbox, finds it. `install` is its own container from
 * the same image on a network with the registry in reach, as root with npm on its path, which no
 * tool run has (`Dockerfile`).
 */

export type DockerSandboxBackendOptions = {
  /** The prebuilt image, built from this package's `Dockerfile`; e.g. `graft-sandbox:dev`. */
  image: string;
  /**
   * The internal network sandboxes are created on. Must exist and be `internal`; `ensure` checks and
   * refuses otherwise, because a sandbox on a network with a gateway has egress ADR 0013 forbids.
   * The proxy container is attached to it by whoever runs the proxy (the compose file, GRA-33).
   */
  network: string;
  /** `DOCKER_HOST` as the CLI reads it. Defaults to `process.env.DOCKER_HOST`, then the local socket. */
  dockerHost?: string;
  /**
   * Prefixes every container name and the label `list` filters by, so two backings on one daemon —
   * two checkouts, or a test beside a running server — see only their own sandboxes. Default
   * `graft-sandbox`.
   */
  prefix?: string;
  /** Prefixes every toolbox volume name. Default `graft-toolbox`. Shared by every backing of one deployment. */
  toolboxVolumePrefix?: string;
  install?: {
    /**
     * The network an install container runs on. Default `bridge`, the daemon's own, which reaches the
     * internet; a deployment that wants the registry alone puts a network here whose route out is a
     * registry mirror or forward proxy (ADR 0013's curated mirror, GRA-9). This backing enforces only
     * that the network differs from the sandbox network.
     */
    network?: string;
    /** The registry npm resolves from. Default `https://registry.npmjs.org/`. */
    registry?: string;
  };
};

export type DockerSandboxBackend = SandboxBackend & {
  engine: DockerEngine;
  /** The container name a sandbox name maps to, for a test or an operator looking at `docker ps`. */
  containerName(name: string): string;
  /** The volume name a toolbox id maps to. */
  toolboxVolumeName(toolboxId: string): string;
  /** Remove every toolbox volume this backing's prefix names. For tests; a deployment never does this. */
  removeToolboxVolumes(): Promise<void>;
};

export const DEFAULT_PREFIX = "graft-sandbox";
export const DEFAULT_TOOLBOX_VOLUME_PREFIX = "graft-toolbox";
export const DEFAULT_INSTALL_NETWORK = "bridge";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** The sandbox user the `Dockerfile` creates; files the backing writes are owned by it. */
export const SANDBOX_USER = "graft";
export const SANDBOX_UID = 10001;
export const SANDBOX_GID = 10001;
/** Where the `Dockerfile` puts npm, on the install container's PATH and nobody else's. */
const NPM_BIN = "/opt/graft/npm/bin";
/** Where the toolbox is mounted inside an install container. */
const INSTALL_TOOLBOX_MOUNT = "/tools";
/** Where a detached process's record lives: `<dir>/<name>/{stdout,stderr,code,pid}`. */
const PROCESS_RECORDS = "/var/lib/graft/processes";
const DEFAULT_WORKING_DIR = "/workspace";

const LABEL_PREFIX = "graft.sandbox.prefix";
const LABEL_NAME = "graft.sandbox.name";
const LABEL_INSTALL = "graft.sandbox.install";

const DEFAULT_EXEC_TIMEOUT_SECONDS = 30;
const DEFAULT_DETACHED_TIMEOUT_SECONDS = 600;
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 600;
/** Grace after a process's own `timeout` before the backing gives up on its stream. */
const STREAM_GRACE_MS = 15_000;

/**
 * Start a command in the background and return once its record exists. `$0` is the record
 * directory, `$1` the kill bound in seconds, `$2` the command. The subshell's own stdio is sent to
 * `/dev/null` so it holds none of the exec's pipes and the exec ends when this script does, while
 * the subshell lives on under the container's init. The exit code lands via a rename, so a poll
 * never reads a half-written file.
 */
const DETACHED_START_SCRIPT = `
d="$0"
rm -rf "$d" && mkdir -p "$d" || exit 1
: > "$d/stdout"
: > "$d/stderr"
( timeout -s KILL "$1" sh -c "$2" > "$d/stdout" 2> "$d/stderr" < /dev/null; echo "$?" > "$d/code.tmp" && mv "$d/code.tmp" "$d/code" ) > /dev/null 2>&1 &
echo "$!" > "$d/pid"
`;

/**
 * Report a detached process: first line of stdout is its state, the rest of stdout is the process's
 * stdout, and stderr is the process's stderr — the two streams ride the exec's own two, so one round
 * trip carries everything. `$0` is the record directory.
 */
const DETACHED_POLL_SCRIPT = `
d="$0"
if [ ! -d "$d" ]; then echo NONE; exit 0; fi
if [ -f "$d/code" ]; then echo "EXITED $(cat "$d/code")"
elif [ ! -s "$d/pid" ]; then echo RUNNING
elif kill -0 "$(cat "$d/pid")" 2>/dev/null; then echo RUNNING
else echo LOST
fi
cat "$d/stdout" 2>/dev/null
cat "$d/stderr" >&2 2>/dev/null
`;

/**
 * Create a directory for `writeTree`, as root, giving the sandbox user every directory the call
 * created and nothing that existed. `$0` is the directory, `$1` is `uid:gid`.
 */
const MKDIR_SCRIPT = `
d="$0"; top=""; p="$d"
while [ ! -e "$p" ]; do top="$p"; p=$(dirname "$p"); done
if [ -n "$top" ]; then mkdir -p "$d" && chown -R "$1" "$top"; fi
[ -d "$d" ]
`;

/**
 * ADR 0013's build step. `$0` is the version path under the toolbox mount, `$1` is `uid:gid`. A
 * lockfile present means the exact resolution it records (`npm ci`); absent, the install writes one
 * (`--save-exact` for what it adds). Scripts are disabled twice, on the command and in the
 * environment, because an install script is arbitrary code with the registry in reach. Whatever npm
 * left behind is handed to the sandbox user, so a tool run can read its own dependencies.
 */
const INSTALL_SCRIPT = `
set -u
dir="${INSTALL_TOOLBOX_MOUNT}/$0"
cd "$dir" || { echo "no such version directory in the toolbox: $0" >&2; exit 66; }
[ -f package.json ] || { echo "no package.json in $0" >&2; exit 65; }
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts --no-audit --no-fund
else
  npm install --ignore-scripts --no-audit --no-fund --save-exact
fi
code=$?
chown -R "$1" "$dir"
exit $code
`;

/** The exit code coreutils `timeout -s KILL` reports for a process it killed: 128 + SIGKILL. */
const KILLED_EXIT_CODE = 137;

type ContainerInspect = {
  Id: string;
  Created: string;
  State: { Running: boolean };
  Config: { Labels?: Record<string, string> };
  HostConfig: { Memory?: number };
  Mounts?: { Type: string; Name?: string; Destination: string }[];
};

type ContainerListItem = {
  Id: string;
  Names: string[];
  Created: number;
  Labels?: Record<string, string>;
};

type ExecInspect = { ExitCode: number | null; Running: boolean };

type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  logs: string;
  timedOut: boolean;
};

type VolumeMount = { Type: "volume"; Source: string; Target: string };

export function createDockerSandboxBackend(
  options: DockerSandboxBackendOptions,
): DockerSandboxBackend {
  const engine = new DockerEngine(resolveDockerHost(options.dockerHost ?? process.env.DOCKER_HOST));
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const volumePrefix = options.toolboxVolumePrefix ?? DEFAULT_TOOLBOX_VOLUME_PREFIX;
  const installNetwork = options.install?.network ?? DEFAULT_INSTALL_NETWORK;
  const registry = options.install?.registry ?? DEFAULT_REGISTRY;
  const owner = `${SANDBOX_UID}:${SANDBOX_GID}`;
  assertSandboxName("the backend prefix", prefix);
  assertSandboxName("the toolbox volume prefix", volumePrefix);
  if (installNetwork === options.network) {
    throw new Error(
      `the install network must not be the sandbox network (${options.network}): an install reaches the registry, a sandbox must not`,
    );
  }

  const containerName = (name: string) => `${prefix}-${name}`;
  const toolboxVolumeName = (toolboxId: string) => `${volumePrefix}-${toolboxId}`;

  /** Checked once per backend: the network exists and has no way out. */
  let networkChecked: Promise<void> | undefined;
  const assertInternalNetwork = () => {
    networkChecked ??= (async () => {
      let network: { Internal?: boolean };
      try {
        network = await engine.json<{ Internal?: boolean }>(
          "GET",
          `/networks/${encodeURIComponent(options.network)}`,
        );
      } catch (error) {
        if (error instanceof DockerEngineError && error.status === 404) {
          throw new Error(
            `sandbox network ${options.network} does not exist; create it internal (docker network create --internal ${options.network}) and attach the proxy to it`,
            { cause: error },
          );
        }
        throw error;
      }
      if (network.Internal !== true) {
        throw new Error(
          `sandbox network ${options.network} is not internal: a sandbox on it could reach hosts other than the proxy (ADR 0013)`,
        );
      }
    })();
    return networkChecked;
  };

  async function ensureVolume(toolboxId: string): Promise<string> {
    assertSandboxName("a toolbox id", toolboxId);
    const name = toolboxVolumeName(toolboxId);
    // `POST /volumes/create` returns the existing volume when the name is taken: the idempotence
    // that makes "one toolbox, many sandboxes" one call per sandbox.
    await engine.json("POST", "/volumes/create", {
      body: { Name: name, Labels: { [LABEL_PREFIX]: prefix, "graft.toolbox.id": toolboxId } },
    });
    return name;
  }

  async function inspect(id: string): Promise<ContainerInspect | null> {
    try {
      return await engine.json<ContainerInspect>(
        "GET",
        `/containers/${encodeURIComponent(id)}/json`,
      );
    } catch (error) {
      if (error instanceof DockerEngineError && error.status === 404) return null;
      throw error;
    }
  }

  /** Create and start a sandbox container. */
  async function createContainer(
    name: string,
    args: { memoryMb?: number; mounts: VolumeMount[] },
  ): Promise<string> {
    const { Id } = await engine.json<{ Id: string }>("POST", "/containers/create", {
      query: { name: containerName(name) },
      body: {
        Image: options.image,
        Cmd: ["sleep", "infinity"],
        User: SANDBOX_USER,
        WorkingDir: DEFAULT_WORKING_DIR,
        Labels: { [LABEL_PREFIX]: prefix, [LABEL_NAME]: name },
        HostConfig: {
          ...hardening(),
          NetworkMode: options.network,
          ...(args.memoryMb !== undefined ? { Memory: args.memoryMb * 1024 * 1024 } : {}),
          Mounts: args.mounts,
        },
        NetworkingConfig: { EndpointsConfig: { [options.network]: {} } },
      },
    });
    await engine.json("POST", `/containers/${Id}/start`);
    return Id;
  }

  async function remove(id: string): Promise<void> {
    try {
      await engine.json("DELETE", `/containers/${encodeURIComponent(id)}`, {
        query: { force: true },
      });
    } catch (error) {
      if (error instanceof DockerEngineError && error.status === 404) return;
      throw error;
    }
  }

  /**
   * One exec, waited for. The process is bounded by `timeout` inside the container; the stream is
   * bounded here a little later, for a process whose children outlive it and hold its pipes open.
   */
  async function runExec(
    containerId: string,
    args: {
      cmd: string[];
      env?: Record<string, string>;
      workingDir?: string;
      user?: string;
      timeoutSeconds: number;
    },
  ): Promise<ExecResult> {
    const { Id } = await engine.json<{ Id: string }>("POST", `/containers/${containerId}/exec`, {
      body: {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: args.cmd,
        Env: Object.entries(args.env ?? {}).map(([key, value]) => `${key}=${value}`),
        ...(args.workingDir ? { WorkingDir: args.workingDir } : {}),
        ...(args.user ? { User: args.user } : {}),
      },
    });
    const stream = await engine.stream("POST", `/exec/${Id}/start`, {
      body: { Detach: false, Tty: false },
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        stream.destroy();
      },
      args.timeoutSeconds * 1000 + STREAM_GRACE_MS,
    );
    let output: Awaited<ReturnType<typeof demux>>;
    try {
      output = await demux(stream);
    } catch (error) {
      if (!timedOut) throw error;
      output = { stdout: "", stderr: "", logs: "" };
    } finally {
      clearTimeout(timer);
    }
    const state = await engine.json<ExecInspect>("GET", `/exec/${Id}/json`);
    return {
      exitCode: state.Running ? null : state.ExitCode,
      timedOut: timedOut || state.ExitCode === KILLED_EXIT_CODE,
      ...output,
    };
  }

  function statusOf(exitCode: number | null): SandboxProcessResult["status"] {
    if (exitCode === 0) return "completed";
    if (exitCode === KILLED_EXIT_CODE) return "killed";
    return "failed";
  }

  function createHandle(name: string, initialId: string): SandboxHandle {
    const state = { id: initialId };

    const exec = (args: Parameters<typeof runExec>[1]) => runExec(state.id, args);

    return {
      writeTree: async (files, destination) => {
        assertAbsolute("destination", destination);
        const made = await exec({
          cmd: ["sh", "-c", MKDIR_SCRIPT, destination, owner],
          user: "root",
          timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
        });
        if (made.exitCode !== 0) {
          throw new Error(
            `could not create ${destination} in sandbox ${name}: ${made.logs.trim()}`,
          );
        }
        if (files.length === 0) return;
        await engine.json("PUT", `/containers/${state.id}/archive`, {
          query: { path: destination },
          stream: packTree(files, { uid: SANDBOX_UID, gid: SANDBOX_GID }),
        });
      },

      exec: async (command, execOptions) => {
        const timeoutSeconds = execOptions?.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
        const result = await exec({
          cmd: ["timeout", "-s", "KILL", String(timeoutSeconds), "sh", "-c", command],
          env: execOptions?.env,
          workingDir: execOptions?.workingDir,
          timeoutSeconds,
        });
        return result.logs.trim();
      },

      execDetached: async (command, detachedOptions) => {
        assertSandboxName("a detached process name", detachedOptions.name);
        const timeoutSeconds = detachedOptions.timeoutSeconds ?? DEFAULT_DETACHED_TIMEOUT_SECONDS;
        const started = await exec({
          cmd: [
            "sh",
            "-c",
            DETACHED_START_SCRIPT,
            `${PROCESS_RECORDS}/${detachedOptions.name}`,
            String(timeoutSeconds),
            command,
          ],
          env: detachedOptions.env,
          workingDir: detachedOptions.workingDir,
          timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
        });
        if (started.exitCode !== 0) {
          throw new Error(
            `could not start ${detachedOptions.name} in sandbox ${name}: ${started.logs.trim()}`,
          );
        }
        return detachedOptions.name;
      },

      waitForProcess: async (processName, { maxWaitSeconds, pollIntervalMs = 1000 }) => {
        const deadline = Date.now() + maxWaitSeconds * 1000;
        for (;;) {
          const polled = await exec({
            cmd: ["sh", "-c", DETACHED_POLL_SCRIPT, `${PROCESS_RECORDS}/${processName}`],
            timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
          });
          const newline = polled.stdout.indexOf("\n");
          const stateLine = newline === -1 ? polled.stdout : polled.stdout.slice(0, newline);
          const stdout = newline === -1 ? "" : polled.stdout.slice(newline + 1);
          const stderr = polled.stderr;
          const streams = { stdout, stderr, logs: `${stdout}${stderr}` };
          if (stateLine === "NONE") {
            const logs = `no process named ${processName}`;
            return { status: "failed", exitCode: null, logs, stdout: "", stderr: logs };
          }
          if (stateLine === "LOST") {
            return { status: "failed", exitCode: null, ...streams };
          }
          if (stateLine.startsWith("EXITED ")) {
            const exitCode = Number.parseInt(stateLine.slice("EXITED ".length), 10);
            return { status: statusOf(exitCode), exitCode, ...streams };
          }
          if (Date.now() >= deadline) {
            return { status: "running", exitCode: null, ...streams };
          }
          await sleep(pollIntervalMs);
        }
      },

      mountToolbox: async ({ toolboxId, mountPath }) => {
        assertAbsolute("mountPath", mountPath);
        const target = normaliseDir(mountPath);
        const volume = await ensureVolume(toolboxId);
        const current = await inspect(state.id);
        if (!current) throw new Error(`sandbox ${name} no longer exists`);
        const mounts = (current.Mounts ?? []).filter((mount) => mount.Type === "volume");
        if (
          mounts.some(
            (mount) => mount.Name === volume && normaliseDir(mount.Destination) === target,
          )
        ) {
          return;
        }
        // A running container cannot take a new mount, so the sandbox is recreated around it: same
        // name, same network, same memory, every other toolbox it had, plus this one. Only the
        // volumes survive — the container's own filesystem, and any detached process, do not. That
        // is why `SandboxHandle.mountToolbox` says to mount first.
        const kept: VolumeMount[] = mounts
          .filter((mount) => mount.Name && normaliseDir(mount.Destination) !== target)
          .map((mount) => ({
            Type: "volume",
            Source: mount.Name ?? "",
            Target: mount.Destination,
          }));
        const memory = current.HostConfig.Memory;
        await remove(state.id);
        state.id = await createContainer(name, {
          ...(memory ? { memoryMb: memory / (1024 * 1024) } : {}),
          mounts: [...kept, { Type: "volume", Source: volume, Target: target }],
        });
      },

      downloadDirectory: async (path) => {
        assertAbsolute("path", path);
        const archive = await engine.stream("GET", `/containers/${state.id}/archive`, {
          query: { path: normaliseDir(path) },
        });
        const entries = await readTar(archive);
        if (entries[0]?.type !== "directory") {
          throw new Error(`${path} is not a directory in sandbox ${name}`);
        }
        return filesUnder(entries);
      },

      ls: async (path) => {
        assertAbsolute("path", path);
        const dir = normaliseDir(path);
        const listed = await exec({
          cmd: ["find", dir, "-mindepth", "1", "-maxdepth", "1", "-print"],
          timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
        });
        if (listed.exitCode !== 0) {
          throw new Error(`cannot list ${path} in sandbox ${name}: ${listed.stderr.trim()}`);
        }
        return listed.stdout.split("\n").filter(Boolean).sort();
      },

      read: async (path) => {
        assertAbsolute("path", path);
        const archive = await engine.stream("GET", `/containers/${state.id}/archive`, {
          query: { path },
        });
        const [entry] = await readTar(archive);
        if (entry?.type !== "file") {
          throw new Error(`${path} is not a file in sandbox ${name}`);
        }
        return entry.content.toString("utf8");
      },
    };
  }

  const backend: DockerSandboxBackend = {
    engine,
    containerName,
    toolboxVolumeName,

    ensure: async ({ name, memoryMb }: EnsureSandboxArgs) => {
      assertSandboxName("a sandbox name", name);
      await assertInternalNetwork();
      const current = await inspect(containerName(name));
      if (current) {
        if (current.Config.Labels?.[LABEL_NAME] !== name) {
          throw new Error(
            `container ${containerName(name)} exists but is not a sandbox of this backing`,
          );
        }
        if (!current.State.Running) await engine.json("POST", `/containers/${current.Id}/start`);
        return { handle: createHandle(name, current.Id), existed: true };
      }
      const id = await createContainer(name, { memoryMb, mounts: [] });
      return { handle: createHandle(name, id), existed: false };
    },

    destroy: async (name) => {
      await remove(containerName(name));
    },

    list: async () => {
      const containers = await engine.json<ContainerListItem[]>("GET", "/containers/json", {
        query: { all: true, filters: JSON.stringify({ label: [`${LABEL_PREFIX}=${prefix}`] }) },
      });
      return containers
        .filter((container) => container.Labels?.[LABEL_NAME] !== undefined)
        .map(
          (container): SandboxSummary => ({
            name: container.Labels?.[LABEL_NAME] ?? "",
            createdAt: container.Created ? new Date(container.Created * 1000).toISOString() : null,
          }),
        );
    },

    install: async ({
      toolboxId,
      versionPath,
      timeoutSeconds = DEFAULT_INSTALL_TIMEOUT_SECONDS,
    }) => {
      assertVersionPath(versionPath);
      const volume = await ensureVolume(toolboxId);
      const { Id } = await engine.json<{ Id: string }>("POST", "/containers/create", {
        body: {
          Image: options.image,
          User: "root",
          Cmd: ["sh", "-c", INSTALL_SCRIPT, versionPath, owner],
          Env: [
            `PATH=${NPM_BIN}:/usr/local/bin:/usr/bin:/bin`,
            "HOME=/root",
            `npm_config_registry=${registry}`,
            "npm_config_ignore_scripts=true",
            "npm_config_audit=false",
            "npm_config_fund=false",
            "npm_config_update_notifier=false",
            "npm_config_cache=/tmp/npm-cache",
          ],
          WorkingDir: INSTALL_TOOLBOX_MOUNT,
          Labels: { [LABEL_PREFIX]: prefix, [LABEL_INSTALL]: `${toolboxId}/${versionPath}` },
          HostConfig: {
            ...hardening(),
            NetworkMode: installNetwork,
            Mounts: [{ Type: "volume", Source: volume, Target: INSTALL_TOOLBOX_MOUNT }],
          },
        },
      });
      try {
        await engine.json("POST", `/containers/${Id}/start`);
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          engine.json("POST", `/containers/${Id}/kill`).catch(() => undefined);
        }, timeoutSeconds * 1000);
        let statusCode: number;
        try {
          ({ StatusCode: statusCode } = await engine.json<{ StatusCode: number }>(
            "POST",
            `/containers/${Id}/wait`,
          ));
        } finally {
          clearTimeout(timer);
        }
        const logs = await demux(
          await engine.stream("GET", `/containers/${Id}/logs`, {
            query: { stdout: true, stderr: true },
          }),
        );
        return {
          status: killed ? "killed" : statusOf(statusCode),
          exitCode: statusCode,
          ...logs,
        };
      } finally {
        await remove(Id);
      }
    },

    removeToolboxVolumes: async () => {
      const { Volumes } = await engine.json<{ Volumes: { Name: string }[] | null }>(
        "GET",
        "/volumes",
        {
          query: { filters: JSON.stringify({ label: [`${LABEL_PREFIX}=${prefix}`] }) },
        },
      );
      for (const volume of Volumes ?? []) {
        if (!volume.Name.startsWith(`${volumePrefix}-`)) continue;
        await engine
          .json("DELETE", `/volumes/${encodeURIComponent(volume.Name)}`, { query: { force: true } })
          .catch(() => undefined);
      }
    },
  };

  return backend;
}

/**
 * What every container this backing creates runs with. Capabilities are dropped to the three the
 * backing's own root execs need to hand files to the sandbox user; a tool run, as that user, has
 * none of them in effect. The pid limit bounds a runaway; `no-new-privileges` keeps a setuid binary,
 * were one in the image, from being a way up.
 */
function hardening() {
  return {
    Init: true,
    PidsLimit: 512,
    CapDrop: ["ALL"],
    CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
    SecurityOpt: ["no-new-privileges:true"],
  };
}

/** Create an internal network if it does not exist. For a test fixture or a bootstrap; compose declares it. */
export async function ensureInternalNetwork(
  engine: DockerEngine,
  name: string,
): Promise<{ created: boolean }> {
  try {
    const existing = await engine.json<{ Internal?: boolean }>(
      "GET",
      `/networks/${encodeURIComponent(name)}`,
    );
    if (existing.Internal !== true) throw new Error(`network ${name} exists and is not internal`);
    return { created: false };
  } catch (error) {
    if (!(error instanceof DockerEngineError && error.status === 404)) throw error;
  }
  await engine.json("POST", "/networks/create", {
    body: { Name: name, Driver: "bridge", Internal: true, CheckDuplicate: true },
  });
  return { created: true };
}

export async function removeNetwork(engine: DockerEngine, name: string): Promise<void> {
  try {
    await engine.json("DELETE", `/networks/${encodeURIComponent(name)}`);
  } catch (error) {
    if (error instanceof DockerEngineError && error.status === 404) return;
    throw error;
  }
}

function assertAbsolute(what: string, path: string): void {
  if (!path.startsWith("/"))
    throw new Error(`${what} must be an absolute path inside the sandbox: ${path}`);
}

/** `/tools`, `/tools/` and `/tools//` are one directory. */
function normaliseDir(path: string): string {
  return posix.normalize(path).replace(/\/+$/, "") || "/";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type { SandboxFile };
