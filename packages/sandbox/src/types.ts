/**
 * The sandbox seam: what the core asks of the place authored code runs (CONTEXT.md, "Sandbox").
 *
 * ADR 0002 gives every seam exactly two backings behind one interface, and this file is the
 * interface. `@graft/sandbox-docker` in this repository is one backing; the hosted backing is a
 * private package (GRA-20). Nothing below is shaped like either of them — no image name, region,
 * firewall ruleset, drive or TTL — so a service written against these types runs on both, and
 * `sandboxConformance` in `./conformance.ts` is the one suite both must pass. The in-process fake in
 * `./fake.ts` is a third implementation for unit tests; it passes the same suite less the network
 * assertions, which it declares not applicable.
 *
 * Copied from Cando's `sandbox.deps.ts` and re-read rather than trusted (ADR 0011). What changed:
 * `mountDrive` became `mountToolbox`, because what a sandbox mounts is the person's toolbox
 * (CONTEXT.md) and how the backing stores it is its own business; `deleteSandbox` became `destroy`;
 * `install` is new, for ADR 0013's build step; and `setExpiry` and `ensureDrive` are gone. Those two
 * were the hosted provider's own notions — an expiry the provider enforces, a drive created ahead of
 * its mount — with no counterpart in a container that lives until `destroy` and a volume that exists
 * once it is named. A backing that needs either does it inside `ensure` and `mountToolbox`.
 */

export type SandboxFile = { path: string; content: string };

/**
 * The states a process can be in. `running` is the only one that can still change; `killed` is a
 * process the backing stopped at its timeout, which every backing must be able to do because a
 * detached process keeps its sandbox busy for as long as it runs.
 */
export type SandboxProcessStatus = "running" | "completed" | "failed" | "killed";

/**
 * What `waitForProcess` and `install` hand back.
 *
 * `exitCode` is `null` while the status is `running`, on purpose: a provider that reports `0` for a
 * process that has not finished would otherwise let a caller reading the code before the status take
 * a running process for a successful one. Gate on `status`, never on the code.
 */
export type SandboxProcessResult = {
  status: SandboxProcessStatus;
  exitCode: number | null;
  /** stdout and stderr together, in the order the backing saw them. */
  logs: string;
  /** The two streams apart, because a failure's reason is on stderr and a result is on stdout. */
  stdout: string;
  stderr: string;
};

export type ExecOptions = {
  /** Absolute path inside the sandbox. Defaults to the backing's working directory. */
  workingDir?: string;
  /**
   * How long to wait before the process is killed. Defaults to 30. Anything that may run longer is
   * `execDetached` followed by `waitForProcess`.
   */
  timeoutSeconds?: number;
  /**
   * Variables for this process alone. They reach the process and do not leak to the next one on the
   * same sandbox, which is what lets a per-exec capability token ride here rather than in the
   * sandbox's creation-time environment (ADR 0010). The conformance suite asserts both halves.
   */
  env?: Record<string, string>;
};

export type ExecDetachedOptions = {
  /**
   * Chosen by the caller, because the name is how the process is found again — by `waitForProcess`,
   * possibly from a later call holding a different handle to the same sandbox. Letters, digits, `.`,
   * `_` and `-`, so it is a legal file and container name on every backing.
   */
  name: string;
  workingDir?: string;
  env?: Record<string, string>;
  /**
   * Kill the process after this many seconds. Defaults to 600. There is deliberately no way to ask
   * for "never": a detached process holds its sandbox for as long as it runs.
   */
  timeoutSeconds?: number;
};

export type WaitForProcessOptions = {
  /** Give up waiting after this long. The answer then reports `running`, and nothing is killed. */
  maxWaitSeconds: number;
  /** How often to ask. Defaults to a second; a test sets it low. */
  pollIntervalMs?: number;
};

export type MountToolboxArgs = {
  /** The person's toolbox (CONTEXT.md). One toolbox is mounted by every sandbox that works on it. */
  toolboxId: string;
  /** Where the toolbox appears inside the sandbox, e.g. `/tools`. Absolute. */
  mountPath: string;
  /**
   * The agent's blobs directory, mounted alone beside the toolbox (ADR 0023: the scope is the
   * mount). The backing keeps it where it keeps the toolboxes (`.blobs/<agentId>` beside them,
   * `@graft/toolbox`'s layout) and shows that directory and nothing above it at `mountPath`, which
   * is `/blobs`. It rides on the toolbox's call so a backing that recreates the sandbox to attach a
   * mount does so once for both; absent, a blobs mount the sandbox already has is left as it is.
   */
  blobs?: { agentId: string; mountPath: string };
};

export type SandboxHandle = {
  /**
   * Write files under `destination`, creating directories as needed. Paths in `files` are relative
   * to `destination`; a later `downloadDirectory(destination)` returns the same list.
   */
  writeTree(files: SandboxFile[], destination: string): Promise<void>;
  /** Run a command through `sh` and wait for it. The answer is its combined output, trimmed. */
  exec(command: string, options?: ExecOptions): Promise<string>;
  /** Start a command and return at once with its name — what `waitForProcess` takes. */
  execDetached(command: string, options: ExecDetachedOptions): Promise<string>;
  /**
   * Poll a process by name until it stops or the wait runs out. A name nothing was started under
   * answers `failed` with no exit code rather than throwing, so a caller polling from a later turn
   * gets an answer it can show.
   */
  waitForProcess(name: string, options: WaitForProcessOptions): Promise<SandboxProcessResult>;
  /**
   * Make the toolbox visible at a path, and the agent's blobs directory at its own when `blobs` is
   * given. Idempotent for the same ids and paths.
   *
   * Mount before writing anything else to the sandbox. A backing may have to recreate the sandbox to
   * attach a mount, and only the mounts are guaranteed to survive that; `@graft/sandbox-docker` is
   * one that does, and says so on its `mountToolbox`.
   */
  mountToolbox(args: MountToolboxArgs): Promise<void>;
  /**
   * Every file under a directory, recursively, with paths relative to that directory and sorted by
   * path — the shape `writeTree` takes, so a tree read here can be written elsewhere as it is.
   */
  downloadDirectory(path: string): Promise<SandboxFile[]>;
  /** The entries directly under a directory, as absolute paths, sorted. Rejects for a missing path. */
  ls(path: string): Promise<string[]>;
  /** Whole file as text. Rejects when the path does not exist. */
  read(path: string): Promise<string>;
};

export type EnsureSandboxArgs = {
  /**
   * The caller's name for the sandbox; `ensure` with the same name finds the same sandbox. Letters,
   * digits, `.`, `_` and `-`, for `ExecDetachedOptions.name`'s reason.
   */
  name: string;
  /** A memory bound, where the backing can set one. Advisory: a backing without limits ignores it. */
  memoryMb?: number;
};

export type InstallArgs = {
  toolboxId: string;
  /**
   * The version directory, relative to the toolbox root, holding the `package.json` to install
   * from. Relative because the backing decides where the toolbox is mounted in the install step;
   * `..` and a leading `/` are refused.
   */
  versionPath: string;
  /** Kill the install after this many seconds. Defaults to 600. */
  timeoutSeconds?: number;
};

/** A sandbox as the backing lists it. `createdAt` is ISO 8601, or null where the backing has none. */
export type SandboxSummary = { name: string; createdAt: string | null };

/**
 * The backing itself: what exists before there is a sandbox to hold a handle to.
 *
 * Blaxel's backing (private, GRA-20) implements every verb here, `install` included: ADR 0013 moves
 * package resolution out of the sandbox in both forms, so its build step is a separate sandbox with
 * the registry in its allowlist rather than a firewall exception on the run.
 */
export type SandboxBackend = {
  /**
   * Find the sandbox by name or create it. `existed` tells a cold create from a sandbox picked back
   * up, which differ by orders of magnitude in latency and in what is already on the filesystem.
   */
  ensure(args: EnsureSandboxArgs): Promise<{ handle: SandboxHandle; existed: boolean }>;
  /**
   * Remove the sandbox. The toolbox it mounted is untouched — nothing in a toolbox is deleted by the
   * system (CONTEXT.md) — and a name that no longer exists is not an error.
   */
  destroy(name: string): Promise<void>;
  /** Every sandbox this backing created and has not destroyed. */
  list(): Promise<SandboxSummary[]>;
  /**
   * ADR 0013's build step: resolve the packages a version directory declares, into that directory,
   * with install scripts disabled and a lockfile left behind. The one operation on this seam that
   * may reach the package registry, and it runs in its own sandbox with that reach — never in one a
   * tool runs in, which is what keeps every run's egress to the proxy alone. A failed install is an
   * answer, not an exception: the package policy (GRA-18) turns it into a diagnostic for the model.
   */
  install(args: InstallArgs): Promise<SandboxProcessResult>;
};

/** What `ExecDetachedOptions.name`, `EnsureSandboxArgs.name` and a toolbox id may look like. */
export const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Throw unless `value` is a name every backing can use as a file, volume or container name. */
export function assertSandboxName(kind: string, value: string): void {
  if (!SANDBOX_NAME.test(value)) {
    throw new Error(
      `${kind} must be 1-128 letters, digits, '.', '_' or '-' and start with a letter or digit: ${JSON.stringify(value)}`,
    );
  }
}

/** Throw unless `versionPath` is relative and stays inside the toolbox (`InstallArgs.versionPath`). */
export function assertVersionPath(versionPath: string): void {
  const segments = versionPath.split("/");
  if (
    versionPath === "" ||
    versionPath.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `versionPath must be a relative path inside the toolbox with no '.' or '..' segments: ${JSON.stringify(versionPath)}`,
    );
  }
}
