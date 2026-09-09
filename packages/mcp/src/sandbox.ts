import { randomUUID } from "node:crypto";

import { type ModuleSources, readModuleSources, singleFileModule } from "@graft/check";
import type { AgentScope } from "@graft/core";
import { RESULT_MARKER, RUNNER_DIR, RUNNER_PATH, SKILLS_DIR, skillFiles } from "@graft/runner";
import type { SandboxHandle, SandboxProcessResult } from "@graft/sandbox";

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
 * One sandbox per agent, found again by name on every call. The toolbox is mounted **first**, before
 * anything is written: a backing may recreate the sandbox to attach a mount and only the toolbox is
 * guaranteed to survive that (`@graft/sandbox`'s `mountToolbox`), so the runner and the skills are
 * seeded after it, and only when they are not already there. The toolbox id is the person's id,
 * because the toolbox is the person's (ADR 0007): every agent of one person mounts one volume, and a
 * tool published for one is on the disk of all.
 */

/** Where the person's toolbox is mounted inside every sandbox. */
export const TOOLBOX_DIR = "/tools";

/**
 * Drafts live on the toolbox so a half-written module survives the sandbox, under a directory per
 * agent: an `acquire` job (GRA-29) will key its own under a job id; the advanced set's drafts are
 * the agent's.
 */
export const DRAFTS_ROOT = `${TOOLBOX_DIR}/.drafts`;

/** Scratch for a run's input file, stderr file and a detached run's result file. */
export const RUN_SCRATCH_DIR = "/tmp/graft-runs";

export const DEFAULT_SANDBOX_NAME_PREFIX = "agent";

export function draftsDir(agentId: string): string {
  return `${DRAFTS_ROOT}/${agentId}`;
}

export function agentSandboxName(prefix: string, agentId: string): string {
  return `${prefix}-${agentId}`;
}

/** The agent's sandbox, mounted and seeded. Throws what the backing throws; callers wrap it. */
export async function openAgentSandbox(deps: McpDeps, scope: AgentScope): Promise<SandboxHandle> {
  const name = agentSandboxName(
    deps.sandboxNamePrefix ?? DEFAULT_SANDBOX_NAME_PREFIX,
    scope.agentId,
  );
  const { handle } = await deps.sandbox.ensure({ name });
  await handle.mountToolbox({ toolboxId: scope.personId, mountPath: TOOLBOX_DIR });
  await seedRunner(deps, handle);
  return handle;
}

/** Mount the toolbox again — the recovery when a version directory is not where the pointer says. */
export async function remountToolbox(handle: SandboxHandle, scope: AgentScope): Promise<void> {
  await handle.mountToolbox({ toolboxId: scope.personId, mountPath: TOOLBOX_DIR });
}

async function seedRunner(deps: McpDeps, handle: SandboxHandle): Promise<void> {
  const present = await handle.ls(RUNNER_DIR).catch(() => [] as string[]);
  if (present.includes(RUNNER_PATH)) return;
  const runner = await deps.runnerFiles();
  if (runner.length > 0) await handle.writeTree(runner, RUNNER_DIR);
  const skills = skillFiles(await deps.skills());
  if (skills.length > 0) await handle.writeTree(skills, SKILLS_DIR);
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The environment every command runs with: `NODE_USE_ENV_PROXY=1`, because the hosted backing
 * reaches the proxy through `HTTPS_PROXY` and Node's `fetch` ignores it otherwise (`runner.mjs`
 * says so); `GRAFT_TIMEOUT_MS` a little inside the kill bound, so a module that hangs is reported
 * by the runner's own exit code rather than seen killed. No token here — `run.ts` adds one, per
 * process, for a run that may reach a vendor (ADR 0010).
 */
export function commandEnvironment(timeoutSeconds: number): Record<string, string> {
  return {
    NODE_USE_ENV_PROXY: "1",
    GRAFT_TIMEOUT_MS: String(Math.max(1_000, (timeoutSeconds - 2) * 1_000)),
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
): Promise<Record<string, unknown>> {
  if (input.detached) {
    const started = await startDetached(handle, {
      command: input.command,
      env,
      timeoutSeconds: input.timeoutSeconds,
      prefix: "cmd",
    });
    return describeDetachedStart(started);
  }
  const name = processName("cmd");
  await handle.execDetached(input.command, { name, timeoutSeconds: input.timeoutSeconds, env });
  const result = await handle.waitForProcess(name, {
    maxWaitSeconds: input.timeoutSeconds + WAIT_SLACK_SECONDS,
  });
  return describeProcess(result, input.timeoutSeconds);
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
 * Look in on a detached process, and read the runner's result file back when the process wrote one
 * — stdout carries `RESULT_MARKER` followed by the path, which is the runner's detached contract.
 */
export async function pollProcess(
  handle: SandboxHandle,
  input: WaitInput,
): Promise<Record<string, unknown>> {
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
      status: "running",
      ...base,
      waitedSeconds: input.maxWaitSeconds,
      note: `Still running after another ${input.maxWaitSeconds} seconds. Call wait_for_process again with the same processName; the process is killed when its timeoutSeconds elapse.`,
    };
  }

  // The marker says the runner wrote a result; the path is the one this side chose at the start.
  const runner = result.stdout.includes(RESULT_MARKER)
    ? await readRunnerResult(handle, resultPathFor(input.processName))
    : {};

  if (result.status === "killed") {
    return {
      status: "killed",
      ...base,
      ...runner,
      note: `The process was killed before it finished — usually because it ran past its timeoutSeconds. Start it again with a longer timeoutSeconds, up to ${MAX_DETACHED_TIMEOUT_SECONDS} when detached.`,
    };
  }
  if (result.exitCode === 0) return { status: "completed", ...base, ...runner };
  return {
    status: "failed",
    ...base,
    ...runner,
    error: `The process exited with code ${result.exitCode}.`,
  };
}

async function readRunnerResult(
  handle: SandboxHandle,
  resultPath: string,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await handle.read(resultPath));
    const bounded = boundJson(value, MAX_FILE_CHARS);
    if (!bounded.cut) return { resultPath, result: bounded.value };
    return {
      resultPath,
      result: null,
      resultTruncated: true,
      resultHead: bounded.text,
      note: `The result was ${bounded.length} characters and was cut at ${MAX_FILE_CHARS}. Have the module return less, or read resultPath in parts.`,
    };
  } catch (error) {
    return { resultPath, resultError: errorMessage(error) };
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
