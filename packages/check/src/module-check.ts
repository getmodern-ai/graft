import { posix } from "node:path";
import { Worker } from "node:worker_threads";

import { moduleEntryOf } from "@graft/runner/runner-source";

import { type ToolAnnotations, UNKNOWN_ANNOTATIONS } from "./annotations";
import type { Diagnostic, ModuleCheckInput, ModuleCheckResult } from "./module-check.core";

export type {
  AdviceRule,
  Diagnostic,
  DiagnosticRule,
  ModuleCheckFile,
  ModuleCheckInput,
  ModuleCheckResult,
  RefusalRule,
} from "./module-check.core";
export type { ToolAnnotations };
export { UNKNOWN_ANNOTATIONS };

/**
 * The door to the static check. `module-check.core.ts` is the check; this is the budget around it,
 * and the reason the two are separate files: the core imports the TypeScript compiler, some nine
 * megabytes that nothing on the server needs until a module is checked, so the main thread loads only
 * this and the compiler lives in the worker thread the check runs in. Hence `import type` from the
 * core and nothing else.
 *
 * **The budget is what makes untrusted source safe to compile on the server.** A module is text a
 * model wrote; the type checker is not a sandbox, and a pathological input can make it run for a very
 * long time. So: a size cap, refused before any thread starts; and a wall-clock cap, enforced by
 * `worker.terminate()` — the one way to stop synchronous work that is not cooperating. Either refuses
 * with a plain message rather than a stack.
 *
 * Ten seconds: the worker pays for loading the compiler and parsing the ES2024 lib on every check —
 * under a second on a laptop, several on a shared vCPU — and a budget that refuses a clean module on
 * a cold container would teach the model the check is flaky. The check itself is a few hundred
 * milliseconds past that.
 */
export const MODULE_CHECK_MAX_BYTES = 256 * 1024;
export const MODULE_CHECK_TIMEOUT_MS = 10_000;

/** A file of a module, path relative to the module's directory. The shape the sandbox seam reads. */
export type ModuleFile = { path: string; content: string };

/**
 * A module as read off wherever it lives: its files, the entry the check runs from, and the packages
 * its `package.json` declares (ADR 0013). `readModuleSources` and `singleFileModule` build it; the
 * seam that reads a sandbox is wired later and hands over files, not a handle.
 */
export type ModuleSources = {
  files: ModuleFile[];
  entry: string | null;
  dependencies: string[];
};

export type ModuleCheck = (
  input: {
    files: readonly ModuleFile[];
    entry: string | null;
    inputSchema?: Record<string, unknown> | null;
    dependencies?: readonly string[] | null;
  },
  options?: { timeoutMs?: number; maxBytes?: number },
) => Promise<ModuleCheckResult>;

const CHECK_FAILED_HINT =
  "Nothing is wrong with the module as far as the check got; try again, and say so if it repeats.";

/**
 * Check a module in a worker thread under the budget. Never rejects: a worker that crashes, or a
 * check that cannot start, is a `check-failed` refusal the model can read and report.
 */
export const checkModule: ModuleCheck = async (input, options = {}) => {
  const maxBytes = options.maxBytes ?? MODULE_CHECK_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? MODULE_CHECK_TIMEOUT_MS;
  const file = input.entry ?? input.files[0]?.path ?? "";

  if (input.entry === null) {
    return refusal(null, {
      file,
      rule: "entry-missing",
      message:
        "The module has no entry: a directory holds index.ts (or index.mjs) at its top level, or the module is a single .ts or .mjs file.",
      hint: "Write the default export in index.ts beside the module's other files, and check it again.",
    });
  }

  const bytes = input.files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);
  if (bytes > maxBytes) {
    return refusal(input.entry, {
      file,
      rule: "budget",
      message: `The module is ${kib(bytes)} KiB; the check reads up to ${kib(maxBytes)} KiB. A tool makes one call, and data belongs in the vendor, not in the code.`,
      hint: "Cut the module down — drop bundled data and unused helpers — and check it again.",
    });
  }

  const workerInput: ModuleCheckInput = {
    files: input.files,
    entry: input.entry,
    inputSchema: input.inputSchema ?? null,
    dependencies: input.dependencies ?? [],
  };
  return runInWorker(workerInput, timeoutMs);
};

/**
 * A module directory read whole: every file under it — a helper reads the environment as easily as
 * the entry does — with the entry the runner would resolve (`moduleEntryOf`, the runner's order), or
 * null when the directory holds neither entry, and the caller says so: a module that cannot be read
 * cannot be checked, and an unchecked publish is what the check exists to remove. The dependencies
 * are the names under `dependencies` in a top-level `package.json`, which is where the publish step
 * reads them from too (ADR 0013); a missing or unparseable file declares none.
 */
export function readModuleSources(files: readonly ModuleFile[]): ModuleSources {
  const list = files.map((file) => ({ path: normalise(file.path), content: file.content }));
  return {
    files: list,
    entry: moduleEntryOf(list.map((file) => file.path)),
    dependencies: dependenciesOf(list),
  };
}

/** A module that is one file: the file is its own entry, and it vendors nothing. */
export function singleFileModule(path: string, content: string): ModuleSources {
  const name = posix.basename(path);
  return { files: [{ path: name, content }], entry: name, dependencies: [] };
}

/** The names under `dependencies` in the module's own `package.json`; none when there is no such file. */
export function dependenciesOf(files: readonly ModuleFile[]): string[] {
  const manifest = files.find((file) => normalise(file.path) === "package.json");
  if (!manifest) return [];
  try {
    const parsed: unknown = JSON.parse(manifest.content);
    const dependencies =
      typeof parsed === "object" && parsed !== null && "dependencies" in parsed
        ? (parsed as { dependencies: unknown }).dependencies
        : null;
    return typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies)
      ? Object.keys(dependencies).sort()
      : [];
  } catch {
    return [];
  }
}

function normalise(path: string): string {
  return path.trim().replace(/^(\.\/|\/)+/, "");
}

function runInWorker(input: ModuleCheckInput, timeoutMs: number): Promise<ModuleCheckResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), { workerData: input });
    } catch (error) {
      resolve(
        refusal(input.entry, {
          file: input.entry,
          rule: "check-failed",
          message: `The check could not start: ${errorMessage(error)}`,
          hint: CHECK_FAILED_HINT,
        }),
      );
      return;
    }

    let settled = false;
    const finish = (result: ModuleCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const fail = (message: string) =>
      finish(
        refusal(input.entry, {
          file: input.entry,
          rule: "check-failed",
          message: `The check could not run: ${message}`,
          hint: CHECK_FAILED_HINT,
        }),
      );
    const timer = setTimeout(() => {
      finish(
        refusal(input.entry, {
          file: input.entry,
          rule: "budget",
          message: `The check did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped. A tool's module is small; something in this one is very expensive to type.`,
          hint: "Simplify the types — drop deep generics, huge literal unions and recursive helpers — and check it again.",
        }),
      );
    }, timeoutMs);

    worker.once("message", (result: ModuleCheckResult) => finish(result));
    worker.once("error", (error) => fail(errorMessage(error)));
    worker.once("exit", (code) => {
      if (!settled) fail(`the checker exited with code ${code} before answering`);
    });
  });
}

/**
 * The worker's entry, beside this file: `.ts`, run by Node's own type stripping, since this package
 * ships source (AGENTS.md). Resolved off `import.meta.url` so the file is found wherever the package
 * is installed from. A bundled deployment would need a second bundle entry for the worker and the
 * `.mjs` branch here; until one exists, the `.ts` branch is the only one taken.
 */
function workerUrl(): URL {
  const here = import.meta.url;
  return here.endsWith(".ts")
    ? new URL("./module-check.worker.ts", here)
    : new URL("./module-check.worker.mjs", here);
}

function refusal(
  entry: string | null,
  diagnostic: Omit<Diagnostic, "line" | "column" | "text">,
): ModuleCheckResult {
  return {
    entry,
    refusals: [{ line: 1, column: 1, text: "", ...diagnostic }],
    advice: [],
    annotations: UNKNOWN_ANNOTATIONS,
    contextMembersUsed: [],
    blobReadFields: [],
  };
}

/** The message of whatever was thrown — an `Error`'s own, or the value as a string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kib(bytes: number): number {
  return Math.round(bytes / 1024);
}
