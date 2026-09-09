import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import {
  assertSandboxName,
  assertVersionPath,
  type SandboxBackend,
  type SandboxFile,
  type SandboxHandle,
  type SandboxProcessResult,
  type SandboxSummary,
} from "./types";

/**
 * A backing that is a directory on this machine — the one a service's unit tests run against.
 *
 * Reshaped from Cando's `disk-sandbox.ts` (ADR 0011), which existed so an eval could run the *real*
 * runner against a vendor served on localhost. Here it is the seam's third implementation: every
 * sandbox is a temporary directory, every toolbox is another, a mount is a symlink from the one to
 * the other, and a command runs through `sh` with a clean environment — `PATH` and `HOME` plus what
 * the caller put in the per-process env — with its sandbox paths mapped under the root. It passes
 * `sandboxConformance` less the egress assertions, which it declares not applicable: there is no
 * network here to restrict, and nothing to reach the proxy stub with.
 *
 * **This is a directory, not a sandbox.** The guard that refuses a command naming anything real
 * outside the root, or a program the sandbox image does not carry, is against accidents, not
 * adversaries. It is not a boundary, and nothing in production relies on it (ADR 0013's boundary is
 * the Docker backing's network and the hosted backing's firewall).
 */

/**
 * The sandbox's own absolute directories, mapped under the root whether or not a call has created
 * them yet: `mkdir -p /graft/x` must land inside the root, and a dynamic list of what exists could
 * not know that. A mount path (`/tools`, typically) joins this list when it is mounted.
 */
export const FAKE_SANDBOX_ROOTS = ["/tools", "/graft", "/skills", "/workspace", "/tmp", "/home"];

/** Where a command runs when `workingDir` is not given, as in the Docker image. */
const DEFAULT_WORKING_DIR = "/workspace";

/**
 * One of the roots as a shell token. Anchored on a word boundary so `/tools` is matched inside a
 * quoted script argument and `//tools` or `a/tools` is not. Built from the list rather than spelt
 * out beside it, so the two cannot disagree.
 */
function sandboxPathPattern(roots: readonly string[]): RegExp {
  const alternatives = [...new Set(roots)].map((root) =>
    root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`(^|[^\\w./-])(${alternatives.join("|")})(?=/|['"\\s;|&<>)]|$)`, "g");
}

/** Map the sandbox's absolute paths under the root: `/tools/x` → `<root>/tools/x`. */
export function rewriteSandboxPaths(
  command: string,
  root: string,
  roots: readonly string[] = FAKE_SANDBOX_ROOTS,
): string {
  return command.replace(
    sandboxPathPattern(roots),
    (_match, lead: string, path: string) => `${lead}${root}${path}`,
  );
}

/**
 * Programs the sandbox image does not carry (Node 24 and the coreutils basics, nothing that installs
 * or fetches) or that a unit test has no business running on the developer's machine. Refused by
 * name so a caller reaching for curl or npm hears the same "not on this computer" it would in the
 * Docker backing.
 */
const FORBIDDEN_PROGRAMS =
  /(^|[\s;|&(])(curl|wget|ssh|scp|sudo|su|npm|npx|pnpm|yarn|corepack|python3?|pip3?|apk|apt(?:-get)?|brew|git|chmod|chown|kill|pkill|nohup|open|osascript)(?=[\s;|&)]|$)/;

/** An absolute path as a shell token — not part of a URL (`https://…`) or a word. */
const ABSOLUTE_PATH = /(?<![\w.:@%-])\/[\w.@%+-][\w./@%+-]*/g;

/**
 * Why a rewritten command may not run, or null when it may.
 *
 * Every absolute path must be under the root or be `/dev/null`; a `..` segment is refused outright.
 * A token that names nothing real on this machine — a vendor path like `/items` inside a JSON
 * argument, say — is allowed, because the question this guard answers is "does the command reach
 * the host", and a path that is not there cannot be read; a path whose *parent* is there could be
 * written, so that is refused too.
 */
export function refuseCommand(rewritten: string, root: string): string | null {
  if (/(^|[\s'"/])\.\.(?=[\s'"/]|$)/.test(rewritten)) {
    return "a `..` segment would leave the sandbox";
  }
  const forbidden = FORBIDDEN_PROGRAMS.exec(rewritten);
  if (forbidden) {
    return `${forbidden[2]} is not on this computer (the sandbox image has node, sh and the coreutils basics; nothing installs)`;
  }
  // Quotes dropped before the scan: a script may write `'<dir>'/.`, and a `/.` read on its own is
  // the root of the host. Quotes do not change which paths a command names.
  const unquoted = rewritten.replace(/['"]/g, "");
  for (const path of unquoted.match(ABSOLUTE_PATH) ?? []) {
    if (path === root || path.startsWith(`${root}/`) || path === "/dev/null") continue;
    // The parent check skips `/`: a top-level path nothing owns cannot be created without root.
    const parent = dirname(path);
    if (existsSync(path) || (parent !== "/" && existsSync(parent))) {
      return `${path} is outside the sandbox`;
    }
  }
  return null;
}

type Running = {
  done: Promise<SandboxProcessResult>;
  snapshot: () => Pick<SandboxProcessResult, "logs" | "stdout" | "stderr">;
  kill: () => void;
};

/** What a refused command answers with: a failed process, its reason where the output would be. */
function refused(reason: string): Running {
  const logs = `fake sandbox: ${reason}`;
  return {
    done: Promise.resolve({ status: "failed", exitCode: 127, logs, stdout: "", stderr: logs }),
    snapshot: () => ({ logs, stdout: "", stderr: logs }),
    kill: () => undefined,
  };
}

/**
 * Run one command through `sh`: stdout and stderr interleaved as they arrive and kept apart as well,
 * killed at the timeout and reported `killed` rather than left running. The environment is exactly
 * what the caller passed plus `PATH` and `HOME`, so a developer's own variables cannot leak into a
 * module's `process.env` — the same clean shape the Docker image gives a process.
 */
function start(
  command: string,
  sandbox: { root: string; roots: () => readonly string[] },
  options: { env: Record<string, string>; timeoutSeconds: number; workingDir: string },
): Running {
  const rewritten = rewriteSandboxPaths(command, sandbox.root, sandbox.roots());
  const reason = refuseCommand(rewritten, sandbox.root);
  if (reason) return refused(reason);

  let logs = "";
  let stdout = "";
  let stderr = "";
  /**
   * Its own process group, so the timeout can kill everything the shell started. `sh -c "sleep 5"`
   * under dash *forks* `sleep` rather than exec'ing it, so a signal to `sh` alone leaves the
   * grandchild holding the stdio pipes and `close` waiting on it for the full five seconds — which
   * is how a Linux runner finds this while macOS's `sh`, which execs a lone command, passes.
   */
  const child = spawn("sh", ["-c", rewritten], {
    cwd: options.workingDir,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: join(sandbox.root, "home"),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    stdout += text;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    stderr += text;
  });

  let killed = false;
  const kill = () => {
    killed = true;
    // The whole group — see the spawn above. The fallback is for a child that never got a pid.
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(kill, options.timeoutSeconds * 1000);

  const done = new Promise<SandboxProcessResult>((resolve) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += `\n${error.message}`;
      resolve({
        status: "failed",
        exitCode: null,
        logs: `${logs}\n${error.message}`,
        stdout,
        stderr,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: killed ? "killed" : code === 0 ? "completed" : "failed",
        exitCode: killed ? (code ?? 137) : code,
        logs,
        stdout,
        stderr,
      });
    });
  });

  return { done, snapshot: () => ({ logs, stdout, stderr }), kill };
}

async function walk(hostDir: string, relative = ""): Promise<SandboxFile[]> {
  const entries = await readdir(hostDir, { withFileTypes: true });
  const files: SandboxFile[] = [];
  for (const entry of entries) {
    const path = relative ? posix.join(relative, entry.name) : entry.name;
    const absolute = join(hostDir, entry.name);
    // A mount point is a symlink to the toolbox directory; walk through it like the directory it is.
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (await isDir(absolute)));
    if (isDirectory) {
      files.push(...(await walk(absolute, path)));
    } else {
      files.push({ path, content: await readFile(absolute, "utf8") });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function isDir(hostPath: string): Promise<boolean> {
  try {
    return (await readdir(hostPath)) !== undefined;
  } catch {
    return false;
  }
}

type FakeSandbox = {
  name: string;
  root: string;
  createdAt: string;
  processes: Map<string, Running>;
  /** Mount path → toolbox id, so a second mount of the same pair is a no-op and the roots list knows it. */
  mounts: Map<string, string>;
  handle: SandboxHandle;
};

export type FakeSandboxBackend = SandboxBackend & {
  /** The host directory everything lives under: `sandboxes/<name>` and `toolboxes/<toolboxId>`. */
  root: string;
  /** The host directory a sandbox's `/` maps to, for a test that wants to look behind the seam. */
  sandboxRoot(name: string): string;
  /** The host directory a toolbox lives in. */
  toolboxRoot(toolboxId: string): string;
  /** Kill every process still running and delete the directory. */
  close(): Promise<void>;
};

/** A backing in a fresh temporary directory, closed by deleting it. */
export function createFakeSandboxBackend(): FakeSandboxBackend {
  const root = mkdtempSync(join(tmpdir(), "graft-fake-sandbox-"));
  const sandboxes = new Map<string, FakeSandbox>();
  const sandboxRoot = (name: string) => join(root, "sandboxes", name);
  const toolboxRoot = (toolboxId: string) => join(root, "toolboxes", toolboxId);

  async function create(name: string): Promise<FakeSandbox> {
    const sandbox = {
      name,
      root: sandboxRoot(name),
      createdAt: new Date().toISOString(),
      processes: new Map<string, Running>(),
      mounts: new Map<string, string>(),
    };
    for (const dir of FAKE_SANDBOX_ROOTS) {
      await mkdir(join(sandbox.root, dir), { recursive: true });
    }
    const hostPath = (path: string) => join(sandbox.root, posix.normalize(`/${path}`));
    const roots = () => [...FAKE_SANDBOX_ROOTS, ...sandbox.mounts.keys()];
    const startHere = (
      command: string,
      options: { env?: Record<string, string>; timeoutSeconds: number; workingDir?: string },
    ) =>
      start(
        command,
        { root: sandbox.root, roots },
        {
          env: options.env ?? {},
          timeoutSeconds: options.timeoutSeconds,
          workingDir: hostPath(options.workingDir ?? DEFAULT_WORKING_DIR),
        },
      );

    const handle: SandboxHandle = {
      writeTree: async (files, destination) => {
        for (const file of files) {
          const target = hostPath(posix.join(destination, file.path));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, "utf8");
        }
      },
      exec: async (command, options) => {
        const result = await startHere(command, {
          env: options?.env,
          timeoutSeconds: options?.timeoutSeconds ?? 30,
          workingDir: options?.workingDir,
        }).done;
        return result.logs.trim();
      },
      execDetached: async (command, options) => {
        assertSandboxName("a detached process name", options.name);
        sandbox.processes.set(
          options.name,
          startHere(command, {
            env: options.env,
            timeoutSeconds: options.timeoutSeconds ?? 600,
            workingDir: options.workingDir,
          }),
        );
        return options.name;
      },
      waitForProcess: async (name, options) => {
        const running = sandbox.processes.get(name);
        if (!running) {
          const logs = `no process named ${name}`;
          return { status: "failed", exitCode: null, logs, stdout: "", stderr: logs };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const gaveUp = new Promise<SandboxProcessResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: "running", exitCode: null, ...running.snapshot() }),
            options.maxWaitSeconds * 1000,
          );
        });
        try {
          return await Promise.race([running.done, gaveUp]);
        } finally {
          clearTimeout(timer);
        }
      },
      mountToolbox: async ({ toolboxId, mountPath }) => {
        assertSandboxName("a toolbox id", toolboxId);
        if (!mountPath.startsWith("/")) throw new Error(`mountPath must be absolute: ${mountPath}`);
        const normalised = posix.normalize(mountPath).replace(/\/+$/, "") || "/";
        if (sandbox.mounts.get(normalised) === toolboxId) return;
        const target = toolboxRoot(toolboxId);
        await mkdir(target, { recursive: true });
        const link = hostPath(normalised);
        // Whatever was at the path goes, as it does when a container is recreated around a new
        // mount (`SandboxHandle.mountToolbox`). The toolbox itself is never touched here.
        await rm(link, { recursive: true, force: true });
        await mkdir(dirname(link), { recursive: true });
        await symlink(target, link, "dir");
        sandbox.mounts.set(normalised, toolboxId);
      },
      downloadDirectory: (path) => walk(hostPath(path)),
      ls: async (path) => {
        const normalised = posix.normalize(`/${path}`).replace(/\/+$/, "") || "/";
        const names = await readdir(hostPath(normalised));
        return names.map((name) => posix.join(normalised, name)).sort();
      },
      read: async (path) => {
        const host = hostPath(path);
        if ((await lstat(host)).isDirectory()) throw new Error(`${path} is a directory`);
        return readFile(host, "utf8");
      },
    };
    const created = { ...sandbox, handle };
    sandboxes.set(name, created);
    return created;
  }

  return {
    root,
    sandboxRoot,
    toolboxRoot,
    ensure: async ({ name }) => {
      assertSandboxName("a sandbox name", name);
      const existing = sandboxes.get(name);
      if (existing) return { handle: existing.handle, existed: true };
      const sandbox = await create(name);
      return { handle: sandbox.handle, existed: false };
    },
    destroy: async (name) => {
      const sandbox = sandboxes.get(name);
      if (!sandbox) return;
      for (const running of sandbox.processes.values()) running.kill();
      sandboxes.delete(name);
      await rm(sandbox.root, { recursive: true, force: true });
    },
    list: async () =>
      [...sandboxes.values()].map(
        (sandbox): SandboxSummary => ({ name: sandbox.name, createdAt: sandbox.createdAt }),
      ),
    install: async ({ toolboxId, versionPath }) => {
      assertSandboxName("a toolbox id", toolboxId);
      assertVersionPath(versionPath);
      // A stub, on purpose: the fake has no registry to reach and no network to reach it over. A
      // service test that needs an installed dependency puts it in the toolbox directory itself.
      const logs = `install: no-op in the fake backing; ${versionPath} was left as it is (ADR 0013's build step runs only in a real backing)`;
      return { status: "completed", exitCode: 0, logs, stdout: logs, stderr: "" };
    },
    close: async () => {
      for (const sandbox of sandboxes.values()) {
        for (const running of sandbox.processes.values()) running.kill();
      }
      sandboxes.clear();
      await rm(root, { recursive: true, force: true });
    },
  };
}
