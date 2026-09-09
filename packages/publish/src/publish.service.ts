import {
  type Diagnostic,
  type ModuleCheck,
  type ModuleCheckResult,
  readModuleSources,
  type ToolAnnotations,
  UNKNOWN_ANNOTATIONS,
} from "@graft/check";
import {
  createTool,
  nextVersionNumber,
  orNotFound,
  publishToolVersion as recordPublishedVersion,
  type ServiceContext,
  type ToolDeps,
  validateToolDefinition,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AuthoredToolRow, ToolVersionRow } from "@graft/db/repo/tool";
import { moduleEntryFor } from "@graft/runner/runner-source";
import type { SandboxBackend, SandboxProcessResult } from "@graft/sandbox/types";
import {
  assertToolboxPath,
  type ToolboxFile,
  type ToolboxMirror,
  type ToolboxStore,
  versionPath as versionPathOf,
} from "@graft/toolbox";

import { sha256Hex, sourceHashOf } from "./hash";
import {
  forbiddenDraftFiles,
  MANIFEST_FILE,
  type ManifestDependency,
  normaliseManifest,
  type PublishDiagnostic,
  readManifest,
} from "./manifest";
import type { PackageMetadataSource } from "./metadata";
import {
  evaluatePackage,
  isAllowlisted,
  isExactVersion,
  isValidPackageName,
  type PackagePolicyConfig,
} from "./policy";

/**
 * Publishing an authored tool (GRA-1, "The check, the runner and the toolbox"): the draft's files
 * become the next version directory in the person's toolbox, the check's output and annotations go
 * on the version row, the tool's pointer moves, and the mirror is told. In that order, and each step
 * is a place the publish can refuse without having changed anything a run reads:
 *
 *  1. The definition is validated — a bad name never gets a directory.
 *  2. The draft is read through the store. Missing, or carrying a file the install owns, is a refusal.
 *  3. `package.json` is read for the declared packages; any other dependency section is a refusal.
 *  4. The check runs over the files with those dependencies (ADR 0010, ADR 0013 rules included). A
 *     refusal returns the check's diagnostics and nothing is written.
 *  5. Every declared package is put to the package policy (`./policy.ts`); allowlisted names skip
 *     the registry. Every failing package is a diagnostic, all of them at once, so the model fixes
 *     the manifest in one edit.
 *  6. The version directory `tools/<vendor>/<name>/v<N>` is written from the draft's files, the
 *     manifest carrying `"type": "module"` (`normaliseManifest`).
 *  7. When packages are declared, the sandbox backend's `install` runs — ADR 0013's build step, the
 *     one place that reaches the registry — and its lockfile is hashed. A failed install is a
 *     refusal with npm's words in it.
 *  8. The rows: the tool created if this is its first publish, the version inserted, the definition
 *     updated with the check's annotations, the pointer moved — `@graft/core`'s one transaction.
 *  9. The mirror is asked to copy the version, and the publish returns without waiting.
 *
 * A directory written and then not recorded (a failed install, a database down at step 8) stays on
 * disk with no row; the next publish of the tool computes the same version number and writes over
 * it, then installs again. Nothing under `tools/` is removed, by the publish or by anything
 * (ADR 0009). Two publishes of one tool racing both compute the same number; the unique constraint
 * on (tool, version) refuses the second's row, and the second's files may have overwritten the
 * first's — `acquire` runs one job per tool at a time (GRA-29), which is what keeps that theoretical.
 *
 * Copied in shape from Cando's `publishAuthoredTool` and re-read (ADR 0011): the sandbox no longer
 * does the copy — the server holds the toolbox — and the package policy, the install step and the
 * mirror seam are Graft's (ADR 0002, ADR 0013).
 */

export type PublishArgs = {
  personId: string;
  /** The agent whose acquire job this is, when one is; carried to the mirror event, never to a row. */
  agentId?: string | null;
  /** The acquire job publishing, recorded on the version as `publisherJobId`. */
  jobId?: string | null;
  /** The person's toolbox (`toolboxIdOf(personId)` in `@graft/toolbox`). */
  toolboxId: string;
  vendor: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Where the module is, relative to the toolbox root: a draft directory (`draftPath(jobId)`), a
   * directory under one, or a single `.ts`/`.mjs` file, which is published as the entry.
   */
  draftPath: string;
  /** The connection the tool was authored against — its default binding at run time. */
  defaultConnectionId?: string | null;
};

export type PublishSuccess = {
  ok: true;
  tool: AuthoredToolRow;
  version: ToolVersionRow;
  /** The check's advice — non-refusing observations the model may act on. */
  advice: Diagnostic[];
  /** What the check derived (ADR 0008); also on `tool.readOnly` and `tool.destructive`. */
  annotations: ToolAnnotations;
  /** The packages installed into the version, by name; empty when the module declares none. */
  dependencies: string[];
};

export type PublishRefusal = {
  ok: false;
  refusals: PublishDiagnostic[];
  advice: Diagnostic[];
  annotations: ToolAnnotations;
};

export type PublishOutcome = PublishSuccess | PublishRefusal;

/** What the mirror did, reported off the publish's path. */
export type MirrorEvent = {
  outcome: "mirrored" | "failed";
  personId: string;
  agentId: string | null;
  toolboxId: string;
  versionPath: string;
  toolId: string;
  versionId: string;
  durationMs: number;
  /** On a failure, the error flattened to one line. */
  cause?: string;
};

export type PublishDeps = {
  db: DbOrTx;
  store: ToolboxStore;
  mirror: ToolboxMirror;
  /** The build step and nothing else of the sandbox seam. */
  sandbox: Pick<SandboxBackend, "install">;
  metadata: PackageMetadataSource;
  policy: PackagePolicyConfig;
  /** `@graft/core`'s tool service seam — the rows. */
  tool: ToolDeps;
  /** The check; the real one is pure and a test uses it as it is. */
  check: ModuleCheck;
  now: () => Date;
  /** Where the mirror's outcome goes — a wide event in the server. Never on the publish's path. */
  onMirror: (event: MirrorEvent) => void;
};

/** How much of npm's stderr a failed install's diagnostic carries. The end is where the reason is. */
const INSTALL_STDERR_TAIL = 2_000;

export async function publishToolVersion(
  deps: PublishDeps,
  args: PublishArgs,
): Promise<PublishOutcome> {
  validateToolDefinition(args);
  assertToolboxPath(args.draftPath);
  const ctx: ServiceContext = { db: deps.db };
  const principal = { personId: args.personId };

  // 2. The draft.
  const draft = await readDraft(deps.store, args.toolboxId, args.draftPath);
  if (draft === null) {
    return refusal([
      {
        file: args.draftPath,
        line: 1,
        column: 1,
        text: "",
        rule: "draft-missing",
        message: `Nothing is at ${args.draftPath} in the toolbox: no directory with an index.ts (or index.mjs) and no module file.`,
        hint: "Write the module under the draft path — index.ts exporting a default async (input, ctx) — and publish again.",
      },
    ]);
  }
  const forbidden = forbiddenDraftFiles(draft);
  if (forbidden.length > 0) return refusal(forbidden);

  // 3. The manifest.
  const manifest = readManifest(draft);
  if (!manifest.ok) return refusal(manifest.refusals);
  const dependencies = manifest.dependencies;

  // 4. The check.
  const sources = readModuleSources(draft);
  const check = await deps.check({
    files: sources.files,
    entry: sources.entry,
    inputSchema: args.inputSchema,
    dependencies: dependencies.map((dependency) => dependency.name),
  });
  if (check.refusals.length > 0) {
    return {
      ok: false,
      refusals: check.refusals,
      advice: check.advice,
      annotations: check.annotations,
    };
  }

  // 5. The policy, every package at once.
  const policyRefusals = await applyPolicy(dependencies, deps);
  if (policyRefusals.length > 0) return refusal(policyRefusals, check);

  // 6. The version directory.
  const existing = await deps.tool.findAuthoredTool(ctx.db, args.personId, {
    vendor: args.vendor,
    name: args.name,
  });
  const versionNumber = existing
    ? orNotFound(await nextVersionNumber(ctx, principal, existing.id, deps.tool), "Tool not found")
    : 1;
  const versionPath = versionPathOf(args.vendor, args.name, versionNumber);
  const written = normaliseManifest(sources.files);
  await deps.store.writeTree(args.toolboxId, versionPath, written);
  const sourceHash = sourceHashOf(written);

  // 7. The build step.
  let lockfileHash: string | null = null;
  if (dependencies.length > 0) {
    const result = await deps.sandbox.install({ toolboxId: args.toolboxId, versionPath });
    if (result.status !== "completed") return refusal([installFailure(result, versionPath)], check);
    const lockfile = await deps.store
      .read(args.toolboxId, `${versionPath}/package-lock.json`)
      .catch(() => null);
    if (lockfile === null) {
      return refusal(
        [
          installDiagnostic(
            `The install reported success but left no package-lock.json in ${versionPath}, so the version cannot say what it resolved (ADR 0013).`,
            "Publish again; if it repeats, the sandbox backing's install step is not writing a lockfile.",
          ),
        ],
        check,
      );
    }
    lockfileHash = sha256Hex(lockfile);
  }

  // 8. The rows.
  const definition = {
    description: args.description,
    inputSchema: args.inputSchema,
    annotations: check.annotations,
    defaultConnectionId: args.defaultConnectionId ?? null,
  };
  const recorded = await ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const tool =
      existing ??
      (await createTool(
        scoped,
        principal,
        { vendor: args.vendor, name: args.name, ...definition },
        deps.tool,
      ));
    return recordPublishedVersion(
      scoped,
      principal,
      tool.id,
      {
        path: versionPath,
        sourceHash,
        lockfileHash,
        checkOutput: checkOutputOf(check),
        writesInvolved: !check.annotations.readOnly,
        publisherJobId: args.jobId ?? null,
      },
      definition,
      deps.tool,
    );
  });

  // 9. The mirror, off the path.
  startMirror(deps, args, recorded, versionPath);

  return {
    ok: true,
    tool: recorded.tool,
    version: recorded.version,
    advice: check.advice,
    annotations: check.annotations,
    dependencies: dependencies.map((dependency) => dependency.name),
  };
}

/**
 * The draft as module files: a directory read whole, or a single file published as the entry the
 * runner resolves (`moduleEntryFor`). Null when nothing is there.
 */
async function readDraft(
  store: ToolboxStore,
  toolboxId: string,
  draftPath: string,
): Promise<ToolboxFile[] | null> {
  if (!(await store.exists(toolboxId, draftPath))) return null;
  try {
    return await store.readTree(toolboxId, draftPath);
  } catch {
    // Not a directory: a single module file, or something else that is neither.
  }
  if (!/\.m?[tj]s$/.test(draftPath)) return null;
  try {
    const content = await store.read(toolboxId, draftPath);
    return [{ path: moduleEntryFor(draftPath), content }];
  } catch {
    return null;
  }
}

/**
 * Every declared package against the policy. The registry is asked only where its answer can change
 * the verdict: not for an allowlisted name, and not for a name or a version the policy's first rules
 * refuse on the manifest alone — so a range spec is an `exact-version` refusal even while the
 * registry is down, never a `registry-unavailable` one.
 */
async function applyPolicy(
  dependencies: readonly ManifestDependency[],
  deps: Pick<PublishDeps, "metadata" | "policy" | "now">,
): Promise<PublishDiagnostic[]> {
  const now = deps.now();
  const refusals: PublishDiagnostic[] = [];
  for (const dependency of dependencies) {
    const needsRegistry =
      isValidPackageName(dependency.name) &&
      isExactVersion(dependency.spec) &&
      !isAllowlisted(dependency.name, deps.policy.allowlist);
    let metadata = null;
    if (needsRegistry) {
      try {
        metadata = await deps.metadata.lookup(dependency.name, dependency.spec);
      } catch (error) {
        refusals.push({
          file: MANIFEST_FILE,
          line: dependency.line,
          column: dependency.column,
          text: `"${dependency.name}": "${dependency.spec}"`,
          rule: "registry-unavailable",
          message: `The registry could not be asked about ${dependency.name}@${dependency.spec}: ${describe(error)}`,
          hint: "Publish again in a moment; if it keeps failing, write the calls through ctx.fetch instead of the package.",
        });
        continue;
      }
    }
    const verdict = evaluatePackage(
      { name: dependency.name, version: dependency.spec, metadata },
      { ...deps.policy, now },
    );
    if (verdict.allowed) continue;
    refusals.push({
      file: MANIFEST_FILE,
      line: dependency.line,
      column: dependency.column,
      text: `"${dependency.name}": "${dependency.spec}"`,
      rule: "package-policy",
      message: `${dependency.name}@${dependency.spec} fails the package policy (${verdict.rule}): ${verdict.message}`,
      hint:
        verdict.rule === "exact-version"
          ? `Pin ${dependency.name} to one exact version under dependencies.`
          : `Drop ${dependency.name} and make the vendor's calls by hand through ctx.fetch — a refused package is a blocked shortcut, not a blocked tool.`,
      policy: { package: dependency.name, version: dependency.spec, rule: verdict.rule },
    });
  }
  return refusals;
}

function installFailure(result: SandboxProcessResult, versionPath: string): PublishDiagnostic {
  const output = (result.stderr || result.logs).trim();
  const tail =
    output.length > INSTALL_STDERR_TAIL ? `…${output.slice(-INSTALL_STDERR_TAIL)}` : output;
  const how =
    result.status === "killed"
      ? "was killed at its time limit"
      : result.status === "running"
        ? "was still running when the wait ran out"
        : `failed (exit code ${result.exitCode ?? "unknown"})`;
  return installDiagnostic(
    `The install of the declared packages into ${versionPath} ${how}: ${tail || "no output"}`,
    "Fix what npm names — a version that does not exist, a package that does not — or drop the package and write the calls through ctx.fetch.",
  );
}

function installDiagnostic(message: string, hint: string): PublishDiagnostic {
  return {
    file: MANIFEST_FILE,
    line: 1,
    column: 1,
    text: "",
    rule: "install-failed",
    message,
    hint,
  };
}

/** The check's result as the version row stores it: the same four fields, as plain JSON. */
function checkOutputOf(check: ModuleCheckResult): Record<string, unknown> {
  return {
    entry: check.entry,
    refusals: check.refusals,
    advice: check.advice,
    annotations: check.annotations,
  };
}

function refusal(refusals: PublishDiagnostic[], check?: ModuleCheckResult): PublishRefusal {
  return {
    ok: false,
    refusals,
    advice: check?.advice ?? [],
    annotations: check?.annotations ?? UNKNOWN_ANNOTATIONS,
  };
}

/**
 * Ask the mirror and return at once. Whatever it does — resolve, reject, throw synchronously — ends
 * in one `onMirror` event and nothing else; a reporter that throws is swallowed too, because a
 * dropped promise that rejects is an unhandled rejection in a process that just answered a caller.
 */
function startMirror(
  deps: Pick<PublishDeps, "mirror" | "onMirror" | "now">,
  args: PublishArgs,
  recorded: { tool: AuthoredToolRow; version: ToolVersionRow },
  versionPath: string,
): void {
  const started = deps.now().getTime();
  const event = (outcome: MirrorEvent["outcome"], cause?: unknown): MirrorEvent => ({
    outcome,
    personId: args.personId,
    agentId: args.agentId ?? null,
    toolboxId: args.toolboxId,
    versionPath,
    toolId: recorded.tool.id,
    versionId: recorded.version.id,
    durationMs: deps.now().getTime() - started,
    ...(cause === undefined ? {} : { cause: describe(cause) }),
  });
  Promise.resolve()
    .then(() => deps.mirror.mirrorVersion(args.toolboxId, versionPath))
    .then(
      () => deps.onMirror(event("mirrored")),
      (error: unknown) => deps.onMirror(event("failed", error)),
    )
    .catch(() => undefined);
}

/** An error and its causes as one line, for a diagnostic or an event. */
function describe(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" ← ");
}
