import { createHash, randomUUID } from "node:crypto";

import { type ModuleSources, readModuleSources, singleFileModule } from "@graft/check";
import type { AgentScope } from "@graft/core";
import { causeChain, describeLink, TRUNCATED } from "@graft/proxy/cause-chain";
import {
  type BlobLedgerEntry,
  RESULT_MARKER,
  RUNNER_PATH_VARIABLE,
  type RunnerFile,
  readRunnerEnvelope,
  runnerPath,
  runnerSeedDir,
  SKILLS_SUBDIR,
  skillFiles,
} from "@graft/runner";
import type { MountToolboxArgs, SandboxHandle, SandboxProcessResult } from "@graft/sandbox";
import {
  BLOBS_MOUNT_PATH,
  DRAFTS_DIR,
  draftPath,
  sandboxPath,
  TOOLBOX_MOUNT_PATH,
} from "@graft/toolbox";

import { blobsOnWire } from "./blobs";
import {
  boundJson,
  type CommandInput,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_DETACHED_TIMEOUT_SECONDS,
  MAX_FILE_CHARS,
  MAX_OUTPUT_CHARS,
  tail,
  WAIT_SLACK_SECONDS,
  type WaitInput,
} from "./bounds";
import type { McpDeps } from "./deps";

/**
 * The agent's sandbox — where authored code runs (CONTEXT.md, *Sandbox*) — reached through the
 * seam (ADR 0002) and provisioned the same way on every backing.
 *
 * One sandbox per agent, found again by name on every call. The mounts come **first**, before
 * anything is written: a backing may recreate the sandbox to attach a mount and only the mounts are
 * guaranteed to survive that (`@graft/sandbox`'s `mountToolbox`), so the runner and the skills are
 * seeded after them, under a directory named by their content hash and only when that directory is
 * not there yet (`seedRunner`). The toolbox id is the person's id,
 * because the toolbox is the person's (ADR 0007): every agent of one person mounts one volume, and a
 * tool published for one is on the disk of all. The blobs directory is the agent's own (ADR 0023):
 * `.blobs/<agentId>` beside the toolboxes, mounted alone at `/blobs`, so the scope of a blob is the
 * mount and another agent's blobs are on no path this sandbox can name.
 */

/** Where the person's toolbox is mounted inside every sandbox — `@graft/toolbox`'s layout. */
export const TOOLBOX_DIR = TOOLBOX_MOUNT_PATH;

/** Where the agent's own blobs directory is mounted, alone (`@graft/toolbox`'s layout; ADR 0023). */
export const BLOBS_DIR = BLOBS_MOUNT_PATH;

/** The two mounts every agent sandbox has: the person's toolbox and the agent's blobs directory. */
export function agentMounts(scope: AgentScope): MountToolboxArgs {
  return {
    toolboxId: scope.personId,
    mountPath: TOOLBOX_DIR,
    blobs: { agentId: scope.agentId, mountPath: BLOBS_DIR },
  };
}

/**
 * Drafts live on the toolbox so a half-written module survives the sandbox, under a directory per
 * agent: an `acquire` job (GRA-29) will key its own under a job id (`draftPath(jobId)`); the
 * advanced set's drafts are the agent's, under the same rule with the agent id as the segment.
 */
export const DRAFTS_ROOT = sandboxPath(DRAFTS_DIR);

/** Scratch for a run's input file, stderr file and a detached run's result file. */
export const RUN_SCRATCH_DIR = "/tmp/graft-runs";

export const DEFAULT_SANDBOX_NAME_PREFIX = "agent";

export function draftsDir(agentId: string): string {
  return sandboxPath(draftPath(agentId));
}

/**
 * A sandbox path as the toolbox store names it — `/tools/.drafts/a/x` is `.drafts/a/x` — or null
 * for a path outside the mount, which the store cannot reach. What `publish_tool` hands the publish.
 */
export function toolboxRelativePath(path: string): string | null {
  if (path === TOOLBOX_DIR) return "";
  return path.startsWith(`${TOOLBOX_DIR}/`) ? path.slice(TOOLBOX_DIR.length + 1) : null;
}

export function agentSandboxName(prefix: string, agentId: string): string {
  return `${prefix}-${agentId}`;
}

/** What opening a sandbox reads off the deps: the backing, its name prefix, and the seed's two trees. */
export type SandboxDeps = Pick<McpDeps, "sandbox" | "sandboxNamePrefix" | "runnerFiles" | "skills">;

/** The agent's sandbox, mounted and seeded. Throws what the backing throws; callers wrap it. */
export async function openAgentSandbox(
  deps: SandboxDeps,
  scope: AgentScope,
): Promise<SandboxHandle> {
  if (!deps.sandbox) {
    throw new Error(
      "no sandbox backing is configured on this deployment — set GRAFT_SANDBOX_IMAGE and GRAFT_SANDBOX_NETWORK for Docker, or GRAFT_SANDBOX_BACKEND=fake on a laptop",
    );
  }
  const name = agentSandboxName(
    deps.sandboxNamePrefix ?? DEFAULT_SANDBOX_NAME_PREFIX,
    scope.agentId,
  );
  const { handle } = await deps.sandbox.ensure({ name });
  await handle.mountToolbox(agentMounts(scope));
  await seedRunner(deps, handle);
  return handle;
}

/** Mount the toolbox again — the recovery when a version directory is not where the pointer says. */
export async function remountToolbox(handle: SandboxHandle, scope: AgentScope): Promise<void> {
  await handle.mountToolbox(agentMounts(scope));
}

/**
 * The seed: the runner and the skills as one tree under a directory named by its content hash,
 * `/graft/<hash>/` (`@graft/runner`'s `runnerSeedDir`) — `runner.mjs` at the top, each skill at
 * `skills/<name>/SKILL.md`. The paths are relative to that directory, and the runner is last: its
 * presence is what an open checks, so a runner that is there says the tree before it is too.
 */
type Seed = { files: RunnerFile[]; digest: string };

/**
 * The seed and its digest, computed once per pair of sources: the runner source and the skills are
 * each read once per process (`@graft/runner`), so the hash is too. Keyed on the two functions
 * rather than the deps object, because a test hands different sources under one shape and the
 * server hands one pair under any number of deps objects.
 */
const seeds = new WeakMap<
  SandboxDeps["runnerFiles"],
  WeakMap<SandboxDeps["skills"], Promise<Seed>>
>();

function seedFor(deps: SandboxDeps): Promise<Seed> {
  let bySkills = seeds.get(deps.runnerFiles);
  if (!bySkills) {
    bySkills = new WeakMap();
    seeds.set(deps.runnerFiles, bySkills);
  }
  let seed = bySkills.get(deps.skills);
  if (!seed) {
    seed = Promise.all([deps.runnerFiles(), deps.skills()]).then(([runner, skills]) => {
      const files = [
        ...skillFiles(skills).map((file) => ({
          path: `${SKILLS_SUBDIR}/${file.path}`,
          content: file.content,
        })),
        ...runner,
      ];
      return { files, digest: seedDigest(files) };
    });
    bySkills.set(deps.skills, seed);
  }
  return seed;
}

/**
 * The hex SHA-256 over every seeded file, ordered by its path inside the seed's directory, each as
 * the path, the byte length and the content with a NUL between: two servers shipping the same
 * runner and skills name the same directory, and one that ships a different byte names another.
 */
export function seedDigest(files: readonly RunnerFile[]): string {
  const hash = createHash("sha256");
  const entries = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of entries) {
    hash.update(`${entry.path}\0${Buffer.byteLength(entry.content)}\0`);
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Where this server's runner is in every sandbox it has seeded: `/graft/<hash>/runner.mjs`. */
export async function seededRunnerPath(deps: SandboxDeps): Promise<string> {
  return runnerPath((await seedFor(deps)).digest);
}

/**
 * The runner's path off a command's environment (`commandEnvironment` put it there), for the
 * script `run.ts` builds around a module. Thrown for an environment built any other way.
 */
export function runnerPathIn(env: Record<string, string>): string {
  const path = env[RUNNER_PATH_VARIABLE];
  if (!path) {
    throw new Error(
      `${RUNNER_PATH_VARIABLE} is not in the command's environment; build it with commandEnvironment`,
    );
  }
  return path;
}

/**
 * Seed the runner and the skills, or find them there: a sandbox is one per agent and never destroyed
 * (ADR 0013's Docker consequence as corrected on 2026-09-22; ADR 0023's second paragraph), so a
 * long-lived sandbox runs the server's runner rather than the one it was first seeded with — a
 * deploy that changes `runner.mjs` or a skill seeds its own directory into every agent's sandbox on
 * its next open and runs from it (GRA-193). The directory is named by the content, so two server
 * versions sharing a sandbox through a rolling deploy write two directories and never one path, and
 * two processes of one version write the same bytes to the same paths; there is no marker to
 * disagree with the files. The open reads one file, the runner at this server's path, in place of
 * the directory listing it used to do. What an older server seeded — `/graft/runner.mjs` before
 * GRA-193, another hash's directory after — stays where it is, a few tens of kilobytes each; nothing
 * here removes.
 */
async function seedRunner(deps: SandboxDeps, handle: SandboxHandle): Promise<void> {
  const seed = await seedFor(deps);
  const sentinel = seed.files.at(-1);
  if (!sentinel) return;
  const directory = runnerSeedDir(seed.digest);
  const present = await handle.read(`${directory}/${sentinel.path}`).then(
    () => true,
    () => false,
  );
  if (present) return;
  await handle.writeTree(seed.files, directory);
}

/**
 * The sandbox, or an answer the model can act on: a backing that cannot provision, or work that
 * threw, becomes `{ error }` rather than a thrown tool call, which would end with less.
 */
export async function withSandbox<T>(
  open: () => Promise<SandboxHandle>,
  work: (handle: SandboxHandle) => Promise<T>,
): Promise<T | { error: string }> {
  let handle: SandboxHandle;
  try {
    handle = await open();
  } catch (error) {
    return { error: `The sandbox is unavailable right now: ${errorMessage(error)}` };
  }
  try {
    return await work(handle);
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * The message of whatever was thrown, as one line — the form every job result and tool answer that
 * quotes an error takes (GRA-80). An `Error` is its own message, `[code]` beside it when it carries
 * a string `code`, then every cause down the chain in parentheses: `fetch failed (caused by Error:
 * connect <- Error [ENOTFOUND]: getaddrinfo ENOTFOUND host)`. Each cause is `name [code]: message`,
 * the form the runner's `describeCause` writes on stderr and the proxy's `describeCauseChain` puts
 * on the wide event, joined by ` <- ` as the proxy joins them; the walk is the proxy's `causeChain`,
 * so the cap (five links, then `...`) and the cycle guard are the same one. undici's `fetch failed`
 * says nothing else about what failed — the host, and `ENOTFOUND`, are in the cause.
 *
 * Anything that is not an `Error` — thrown, or sitting in a cause — is `describeLink`'s reading:
 * the sentence inside a plain object before `String(value)`, because a provider SDK throws the
 * vendor API's error body as a plain object (`@blaxel/core` on a refused create or drive call) and
 * `String` of that is `[object Object]`, which is all a job's result once carried of the refusal
 * (GRA-60). `sandbox.test.ts` pins those shapes here, where the job's result is made.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return describeLink(error);
  const { links, truncated } = causeChain(error);
  const causes = links.slice(1).map(describeLink);
  if (truncated) causes.push(TRUNCATED);
  const code = (error as { code?: unknown }).code;
  const own = typeof code === "string" ? ` [${code}]` : "";
  const chain = causes.length > 0 ? ` (caused by ${causes.join(" <- ")})` : "";
  return `${error.message}${own}${chain}`;
}

/**
 * The environment every command runs with: `NODE_USE_ENV_PROXY=1`, because the hosted backing
 * reaches the proxy through `HTTPS_PROXY` and Node's `fetch` ignores it otherwise (`runner.mjs`
 * says so); `GRAFT_TIMEOUT_MS` a little inside the kill bound, so a module that hangs is reported
 * by the runner's own exit code rather than seen killed; `GRAFT_BLOBS_DIR`, where the agent's blobs
 * are mounted (ADR 0023), a variable rather than a constant in the runner for the reason
 * `GRAFT_RESULT_PATH` is one: a backing that maps the sandbox's paths under a root maps the
 * environment's values with them (the fake's `rewriteEnvPaths`), and the runner cannot know the
 * root; and `GRAFT_RUNNER`, where this server's runner is in the sandbox (`seededRunnerPath`), for
 * the same reason and so a command the model types runs `node "$GRAFT_RUNNER" <module>` without
 * knowing the hash (GRA-193). No token here — `run.ts` adds one, per process, for a run that may
 * reach a vendor (ADR 0010).
 */
export function commandEnvironment(
  timeoutSeconds: number,
  runnerPathInSandbox: string,
): Record<string, string> {
  return {
    NODE_USE_ENV_PROXY: "1",
    GRAFT_TIMEOUT_MS: String(Math.max(1_000, (timeoutSeconds - 2) * 1_000)),
    GRAFT_BLOBS_DIR: BLOBS_DIR,
    [RUNNER_PATH_VARIABLE]: runnerPathInSandbox,
  };
}

export function processName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Where a detached process's runner result lands, from the name alone, so the poll can find it
 * from a later turn without the start's answer — and without trusting a path printed by the
 * process, which on a backing that maps paths would name the wrong side of the mapping.
 */
export function resultPathFor(processName: string): string {
  return `${RUN_SCRATCH_DIR}/${processName}.result.json`;
}

export type DetachedStart = {
  processName: string;
  startedAt: string;
  timeoutSeconds: number;
  /** Where a runner invocation inside the command leaves its JSON result (`GRAFT_RESULT_PATH`). */
  resultPath: string;
};

/**
 * Start a command and return at once. `GRAFT_RESULT_PATH` joins the environment so a runner
 * invocation inside the command writes its result where `pollProcess` reads it back.
 */
export async function startDetached(
  handle: SandboxHandle,
  args: { command: string; env: Record<string, string>; timeoutSeconds: number; prefix: string },
): Promise<DetachedStart> {
  const name = processName(args.prefix);
  const resultPath = resultPathFor(name);
  await handle.execDetached(args.command, {
    name,
    timeoutSeconds: args.timeoutSeconds,
    env: { ...args.env, GRAFT_RESULT_PATH: resultPath },
  });
  return {
    processName: name,
    startedAt: new Date().toISOString(),
    timeoutSeconds: args.timeoutSeconds,
    resultPath,
  };
}

/**
 * Run a command and describe what happened — the one path `run_command` and every execute tool
 * take. Detached and then waited for rather than the seam's `exec`, because that verb hands back
 * the output alone and the exit code is the answer these tools exist to give. `env` is the whole
 * per-process environment; the caller decides what the process may know.
 */
export async function runCommand(
  handle: SandboxHandle,
  input: CommandInput,
  env: Record<string, string>,
): Promise<PolledProcess> {
  if (input.detached) {
    const started = await startDetached(handle, {
      command: input.command,
      env,
      timeoutSeconds: input.timeoutSeconds,
      prefix: "cmd",
    });
    return { answer: describeDetachedStart(started), blobs: [], dropped: 0 };
  }
  const name = processName("cmd");
  await handle.execDetached(input.command, { name, timeoutSeconds: input.timeoutSeconds, env });
  const result = await handle.waitForProcess(name, {
    maxWaitSeconds: input.timeoutSeconds + WAIT_SLACK_SECONDS,
  });
  // A runner invoked inside the command wrote its envelope onto stdout (GRA-186): read it off the
  // whole stream before the output is bounded, so a blob a by-hand run wrote gets its row like any
  // other, and name the ledger beside the output.
  const envelope = readRunnerEnvelope(result.stdout);
  const blobs = envelope?.blobs ?? [];
  const dropped = envelope?.dropped ?? 0;
  return {
    answer: { ...describeProcess(result, input.timeoutSeconds), ...blobsOnWire(blobs, dropped) },
    blobs,
    dropped,
  };
}

/** A detached start in words the model can act on. `status: "running"` so it reads like a poll's. */
export function describeDetachedStart(start: DetachedStart): Record<string, unknown> {
  return {
    status: "running",
    processName: start.processName,
    startedAt: start.startedAt,
    timeoutSeconds: start.timeoutSeconds,
    resultPath: start.resultPath,
    note: `Started detached; the process is killed after ${start.timeoutSeconds} seconds. Poll it with wait_for_process and this processName. If it runs a module through the runner, the module's JSON result is written to resultPath and comes back from the poll as result.`,
  };
}

/**
 * A waited process in words the model can act on. Status first, because a backing's exit code can
 * be misleading for a process that is still running (`SandboxProcessResult` records that trap).
 */
export function describeProcess(
  result: SandboxProcessResult,
  timeoutSeconds: number,
): Record<string, unknown> {
  const output = tail(result.logs, MAX_OUTPUT_CHARS);
  const base = {
    output: output.text,
    ...(output.truncated ? { outputTruncated: true } : {}),
  };
  switch (result.status) {
    case "completed":
    case "failed":
      return { exitCode: result.exitCode, ...base };
    case "killed":
      return {
        exitCode: result.exitCode,
        status: "killed",
        ...base,
        note: `The process was killed before it finished — usually because it ran past the ${timeoutSeconds}-second limit. Make it faster, or raise timeoutSeconds up to ${MAX_COMMAND_TIMEOUT_SECONDS}.`,
      };
    case "running":
      return {
        exitCode: null,
        status: "running",
        ...base,
        note: `Still running after ${timeoutSeconds + WAIT_SLACK_SECONDS} seconds; this is what it had printed so far.`,
      };
  }
}

/**
 * What a poll or a waited command answers, and — apart from it — the blobs a runner invocation
 * inside the process wrote (GRA-186): `answer` names them as the agent reads them, `blobs` is the
 * whole ledger for the rows the caller writes (`tools/authoring.ts`, `tools/execute.ts`), which is
 * why the two are not one object.
 */
export type PolledProcess = {
  answer: Record<string, unknown>;
  blobs: BlobLedgerEntry[];
  /** Ledger lines the reader refused (`RunnerEnvelope.dropped`); zero with no envelope. */
  dropped: number;
};

/**
 * Whether a value is `runCommand`'s or `pollProcess`'s answer with its ledger, as against
 * `withSandbox`'s `{ error }`, a refusal or a bare answer. The one spelling of the test (GRA-200):
 * `tools/execute.ts`, `tools/authoring.ts` and `in-flight.ts` each read the ledger off one of
 * these, and three private spellings of the same shape had drifted a word apart.
 */
export function isPolledProcess(value: unknown): value is PolledProcess {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { answer?: unknown; blobs?: unknown };
  return (
    typeof candidate.answer === "object" &&
    candidate.answer !== null &&
    Array.isArray(candidate.blobs)
  );
}

/**
 * Look in on a detached process, and read the runner's result file back when the process wrote one
 * — stdout carries `RESULT_MARKER` followed by the path, which is the runner's detached contract.
 */
export async function pollProcess(handle: SandboxHandle, input: WaitInput): Promise<PolledProcess> {
  const result = await handle.waitForProcess(input.processName, {
    maxWaitSeconds: input.maxWaitSeconds,
  });
  const stdout = tail(result.stdout, MAX_OUTPUT_CHARS);
  const stderr = tail(result.stderr, MAX_OUTPUT_CHARS);
  const base = {
    processName: input.processName,
    exitCode: result.exitCode,
    stdout: stdout.text,
    ...(stderr.text ? { stderr: stderr.text } : {}),
    ...(stdout.truncated || stderr.truncated ? { outputTruncated: true } : {}),
  };

  if (result.status === "running") {
    return {
      answer: {
        status: "running",
        ...base,
        waitedSeconds: input.maxWaitSeconds,
        note: `Still running after another ${input.maxWaitSeconds} seconds. Call wait_for_process again with the same processName; the process is killed when its timeoutSeconds elapse.`,
      },
      blobs: [],
      dropped: 0,
    };
  }

  // The marker says the runner wrote a result; the path is the one this side chose at the start.
  const runner: PolledProcess = result.stdout.includes(RESULT_MARKER)
    ? await readRunnerResult(handle, resultPathFor(input.processName))
    : { answer: {}, blobs: [], dropped: 0 };

  if (result.status === "killed") {
    return {
      answer: {
        status: "killed",
        ...base,
        ...runner.answer,
        note: `The process was killed before it finished — usually because it ran past its timeoutSeconds. Start it again with a longer timeoutSeconds, up to ${MAX_DETACHED_TIMEOUT_SECONDS} when detached.`,
      },
      blobs: runner.blobs,
      dropped: runner.dropped,
    };
  }
  if (result.exitCode === 0) {
    return {
      answer: { status: "completed", ...base, ...runner.answer },
      blobs: runner.blobs,
      dropped: runner.dropped,
    };
  }
  return {
    answer: {
      status: "failed",
      ...base,
      ...runner.answer,
      error: `The process exited with code ${result.exitCode}.`,
    },
    blobs: runner.blobs,
    dropped: runner.dropped,
  };
}

/**
 * The runner's result file: the envelope behind its marker line (`@graft/runner`'s
 * `readRunnerEnvelope`), or a bare result, read as the module's with no blobs. The bare form has one
 * source left (GRA-199): a detached run that a server older than the envelope started (`v0.1.0`'s
 * runner printed a bare result), whose file this server polls after the upgrade, inside the
 * detached ceiling (`MAX_DETACHED_TIMEOUT_SECONDS`). The runner a run started under is the one that
 * writes its file, whatever this server has seeded since (GRA-193), so the window is real if short;
 * a sync run has no such window and `run.ts`'s `unwrapEnvelope` refuses a bare result. A bare result
 * yields no ledger line. The module's result is bounded as a file is; the blobs ride beside it whole.
 */
async function readRunnerResult(handle: SandboxHandle, resultPath: string): Promise<PolledProcess> {
  try {
    const text = await handle.read(resultPath);
    const envelope = readRunnerEnvelope(text);
    const result: unknown = envelope ? envelope.result : JSON.parse(text);
    const blobs = envelope ? envelope.blobs : [];
    const dropped = envelope?.dropped ?? 0;
    const named = blobsOnWire(blobs, dropped);
    const bounded = boundJson(result, MAX_FILE_CHARS);
    if (!bounded.cut) {
      return { answer: { resultPath, result: bounded.value, ...named }, blobs, dropped };
    }
    return {
      answer: {
        resultPath,
        result: null,
        resultTruncated: true,
        resultHead: bounded.text,
        note: `The result was ${bounded.length} characters and was cut at ${MAX_FILE_CHARS}. Have the module return less, or read resultPath in parts.`,
        ...named,
      },
      blobs,
      dropped,
    };
  } catch (error) {
    return { answer: { resultPath, resultError: errorMessage(error) }, blobs: [], dropped: 0 };
  }
}

/**
 * A module as it sits on the sandbox — a directory read whole, or one file — in the shape the check
 * takes. Null when the path is neither, which the caller words for the model.
 */
export async function readModuleFromSandbox(
  handle: SandboxHandle,
  path: string,
): Promise<ModuleSources | null> {
  try {
    return readModuleSources(await handle.downloadDirectory(path));
  } catch {
    try {
      return singleFileModule(path, await handle.read(path));
    } catch {
      return null;
    }
  }
}
