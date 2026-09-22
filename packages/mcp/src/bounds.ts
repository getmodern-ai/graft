import { posix } from "node:path";

/**
 * The numbers every tool description carries and every argument is held to, in one place so two
 * tools cannot tell the model different stories about the same limit. Cando's figures, re-read on
 * the way in (ADR 0011); each has its reason beside it.
 */

/**
 * How long a waited command may run before the sandbox kills it. Sixty seconds by default — long
 * enough to run a module against a vendor twice — and five minutes at most; anything longer is
 * started detached and polled, below.
 */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;
export const MAX_COMMAND_TIMEOUT_SECONDS = 300;

/**
 * The bounds for a command started **detached**: longer, because nothing waits on the call. Ten
 * minutes by default, an hour at most — inside the capability token's own ceiling, which
 * `run.ts`'s `tokenTtlFor` applies regardless.
 */
export const DEFAULT_DETACHED_TIMEOUT_SECONDS = 600;
export const MAX_DETACHED_TIMEOUT_SECONDS = 3600;

/**
 * How long a `<blobId>.tmp` directory may stand before the sweep reads it as a write a killed run
 * abandoned rather than one in progress (ADR 0023, "a blob has one commit point"; GRA-189): the
 * longest any run may live (the detached ceiling, since a detached `run_tool` writes blobs too)
 * plus one sync ceiling as the margin. A `.tmp` younger than this is never touched, and the sweep
 * never runs for an agent with a run in flight at all; this bound is for a process that restarted
 * with a detached run still in a sandbox, and for the by-hand `sweep` script.
 */
export const ABANDONED_BLOB_WRITE_SECONDS =
  MAX_DETACHED_TIMEOUT_SECONDS + MAX_COMMAND_TIMEOUT_SECONDS;

/** Past about this long, a command should be started detached. The one number the descriptions carry. */
export const DETACHED_ADVICE_SECONDS = 45;

/** How long one `wait_for_process` call may hold the turn. */
export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 600;

/** Extra seconds a wait outlasts the kill bound, so a killed process is seen killed rather than running. */
export const WAIT_SLACK_SECONDS = 5;

/** Bounds on what one call puts into the model's context — a file or an output is unbounded by nature. */
export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_FILE_CHARS = 64_000;
export const MAX_RESULT_CHARS = 64_000;
/**
 * How many of a run's blobs the result names beside the module's result (GRA-186). A ledger line is
 * short, so the bound is a count rather than characters; past it the list is cut with a note, and
 * every blob still has its row — the wire is what is bounded, not the record.
 */
export const MAX_RESULT_BLOBS = 32;

/** Bounds on what one call accepts, protecting the request rather than the context. */
export const MAX_WRITE_BYTES = 256 * 1024;
export const MAX_COMMAND_CHARS = 8_000;

/** The shape a detached start mints — a prefix, base-36 time, hex tail — with room for a backing's own. */
export const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The last `max` characters, marked as a tail. The end of an output is where the error is. */
export function tail(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `…${text.slice(text.length - max)}`, truncated: true };
}

/**
 * A value's JSON, whole when it fits `max` and its head when it does not — the one cut every result
 * handed to the model takes. `undefined` reads as `null`, since a result is JSON.
 */
export function boundJson(
  value: unknown,
  max: number,
): { value: unknown; text: string; length: number; cut: boolean } {
  const normalised = value === undefined ? null : value;
  const json = JSON.stringify(normalised);
  if (json.length <= max) return { value: normalised, text: json, length: json.length, cut: false };
  return { value: normalised, text: json.slice(0, max), length: json.length, cut: true };
}

/** A module's result whole when it fits, its head with a note when it does not. */
export function boundResult(
  result: unknown,
): { result: unknown } | { result: null; truncated: true; head: string; note: string } {
  const bounded = boundJson(result, MAX_RESULT_CHARS);
  if (!bounded.cut) return { result: bounded.value };
  return {
    result: null,
    truncated: true,
    head: bounded.text,
    note: `The result was ${bounded.length} characters and was cut at ${MAX_RESULT_CHARS}. Have the tool return less — a page, a summary, the fields the task needs.`,
  };
}

/**
 * The timeout a call asked for, inside the bounds of the path it takes, or the path's default when
 * it did not ask. Clamped rather than refused: a model asking for 900 seconds gets the ceiling and,
 * if the process is killed, a note saying so — which beats a refusal it would retry.
 */
export function clampTimeout(requested: unknown, detached: boolean): number {
  const rounded = Math.round(Number(requested));
  const max = detached ? MAX_DETACHED_TIMEOUT_SECONDS : MAX_COMMAND_TIMEOUT_SECONDS;
  if (!Number.isFinite(rounded)) {
    return detached ? DEFAULT_DETACHED_TIMEOUT_SECONDS : DEFAULT_COMMAND_TIMEOUT_SECONDS;
  }
  return Math.min(max, Math.max(1, rounded));
}

/** What a command tool was asked to run, once its arguments have been read and bounded. */
export type CommandInput = { command: string; timeoutSeconds: number; detached: boolean };

/**
 * A command tool's arguments, read one way — `run_command` and every `execute__<connection>` tool
 * share it, so the two cannot disagree about what a command is or how long it may run.
 */
export function readCommandInput(raw: Record<string, unknown>): CommandInput | { error: string } {
  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    return { error: "command must be a non-empty string" };
  }
  if (raw.command.length > MAX_COMMAND_CHARS) {
    return {
      error: `command is ${raw.command.length} characters; the limit is ${MAX_COMMAND_CHARS}. Write it to a file and run that.`,
    };
  }
  const detached = raw.detached === true;
  return {
    command: raw.command,
    timeoutSeconds: clampTimeout(raw.timeoutSeconds, detached),
    detached,
  };
}

/** What `wait_for_process` was asked, once read and bounded. */
export type WaitInput = { processName: string; maxWaitSeconds: number };

export function readWaitInput(raw: Record<string, unknown>): WaitInput | { error: string } {
  const processName = typeof raw.processName === "string" ? raw.processName.trim() : "";
  if (!PROCESS_NAME_PATTERN.test(processName)) {
    return {
      error: 'processName must be the name a detached start returned, e.g. "cmd-m0abc123-0f9e8d7c"',
    };
  }
  const requested = Math.round(Number(raw.maxWaitSeconds));
  const maxWaitSeconds = Number.isFinite(requested)
    ? Math.min(MAX_WAIT_SECONDS, Math.max(1, requested))
    : DEFAULT_WAIT_SECONDS;
  return { processName, maxWaitSeconds };
}

/**
 * Where a path the model gave lands on the sandbox. An absolute path is taken as given — the
 * sandbox is the agent's own computer and `run_command` reaches anything on it anyway. A relative
 * path goes under the agent's drafts directory on the toolbox, so a half-written module survives
 * the sandbox; one that climbs out of it with `..` is refused, because "relative" was the promise.
 */
export function resolveSandboxPath(
  raw: unknown,
  drafts: string,
): { path: string } | { error: string } {
  if (typeof raw !== "string") return { error: "path must be a string" };
  const candidate = raw.trim();
  if (candidate === "" || /[\0\n\r]/.test(candidate)) {
    return { error: "path must be a non-empty single-line string" };
  }
  if (posix.isAbsolute(candidate)) {
    const path = posix.normalize(candidate);
    if (path.endsWith("/")) return { error: `${raw} names a directory, not a file` };
    return { path };
  }
  const path = posix.normalize(posix.join(drafts, candidate));
  if (path === drafts || path.endsWith("/")) {
    return { error: `${raw} names a directory, not a file` };
  }
  if (!path.startsWith(`${drafts}/`)) {
    return { error: `A relative path stays inside ${drafts}; ${raw} does not.` };
  }
  return { path };
}

/**
 * Where a module to check is — `resolveSandboxPath`'s rule minus its "not a directory" clause,
 * because a module is usually a directory. Whether it exists is the sandbox's to say.
 */
export function resolveModulePath(
  raw: unknown,
  drafts: string,
): { path: string } | { error: string } {
  if (typeof raw !== "string") return { error: "path must be a string" };
  const candidate = raw.trim().replace(/\/+$/, "");
  if (candidate === "" || /[\0\n\r]/.test(candidate)) {
    return { error: "path must be a non-empty single-line string" };
  }
  if (posix.isAbsolute(candidate)) return { path: posix.normalize(candidate) };
  const path = posix.normalize(posix.join(drafts, candidate));
  if (path === drafts || !path.startsWith(`${drafts}/`)) {
    return { error: `A relative path stays inside ${drafts}; ${raw} does not.` };
  }
  return { path };
}
