import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  GOAL_MAX_LENGTH,
  HINTS_MAX_LENGTH,
  redactValue,
  secretFieldNamesFor,
  starterVendorFor,
} from "@graft/core";
import { type ReadWebPage, readWebPage } from "@graft/mcp";
import type { ModelAdapter } from "@graft/model";
import { createUpstreamFetch, type UpstreamFetch } from "@graft/proxy";
import {
  jsonTextNotes,
  proveCheck,
  proveReplay,
  proveTestInput,
  readStockRecording,
} from "@graft/stock/harness";
import type { LiveConnection } from "@graft/stock/mode";
import { recordStockProof } from "@graft/stock/record";
import { formatRecording, RECORDING_FILE, type StockRecording } from "@graft/stock/recording";
import { credentialForms } from "@graft/stock/secrets";
import { readStockWorkspace, STOCK_DIR, type StockWorkspaceTool } from "@graft/stock/workspace";

import { type FormatTool, formatWithBiome } from "./format";
import { runBuildLoop } from "./loop";

/**
 * The stock build command's body (GRA-246; ADR 0025; GRA-231's resolution): build one stock tool
 * with the real `acquire` loop and write it into the stock workspace, or write nothing.
 *
 *  1. The job runs in-process (`loop.ts`) against the maintainer's own connection of a starter
 *     integration, with the integration's documentation as hints and, for a repair (`from`), the
 *     current stock module as the model's starting point.
 *  2. On success the passing draft becomes a tool directory, staged in a temporary workspace: the
 *     module's files, `manifest.json` (the hosts it reached, the annotations the check derived) and
 *     `test-input.json`. Its proof is recorded (`@graft/stock`'s `recordStockProof`: one dry run
 *     through the real proxy, written only through `redactRecording`).
 *  3. The formatted tool is copied into a dot-directory inside the workspace (`INCOMING_PREFIX`),
 *     and must pass the harness's three proofs there as it stands, which is what CI runs.
 *  4. Only then is it renamed into place: new, or, under `from`, in place of the current version,
 *     which is set aside first and put back if the rename fails (`swapInto`), so a failed repair
 *     leaves the tool it started from. The next boot appends the new version to the catalogue (the
 *     catalogue's versions are never edited; ADR 0025).
 *
 * A failed job, a refused draft, a failed recording, a failed copy or a failed proof writes
 * nothing, and replaces nothing.
 */

export type BuildOptions = {
  vendor: string;
  goal: string;
  /** The existing stock tool of the vendor to repair: its name, without the vendor. */
  from?: string | null;
  /** The maintainer's own words for the model, beside the integration's documentation. */
  hints?: string | null;
  model: ModelAdapter;
  /** The maintainer's connections by vendor slug (`GRAFT_STOCK_LIVE_CONNECTIONS`). */
  connections: Readonly<Record<string, LiveConnection>>;
  /** The workspace to write into; `packages/stock/tools` by default. */
  workspace?: string;
  /** The vendor; the proxy's own guarded fetch by default. A suite hands a fake. */
  upstreamFetch?: UpstreamFetch;
  /** How the job reads documentation; the server's reader by default. */
  readWebPage?: ReadWebPage;
  maxAttempts?: number;
  tokenCeiling?: number;
  /** How the staged files are formatted before the proofs; the repository's Biome by default. */
  format?: FormatTool;
  onProgress?: (line: string) => void;
  now?: () => Date;
};

export type BuildResult =
  | {
      ok: true;
      tool: string;
      dir: string;
      /** Whether this replaced a current version (a repair) or made a new tool. */
      replaced: boolean;
      files: string[];
      progress: string[];
    }
  | {
      ok: false;
      /** Why nothing was written: the job's failure kind, or the build's own. */
      failure: string;
      message: string;
      lastDiagnostics?: unknown;
      problems?: string[];
      progress: string[];
    };

const MANIFEST_FILE = "manifest.json";
const TEST_INPUT_FILE = "test-input.json";

/** What every stock build tells the model beside the goal: the rules a stock tool lives under. */
const STOCK_RULES =
  "This is a stock tool: Graft ships it to every person who connects this integration, and its test input is run against the maintainer's test account. Call the vendor through ctx.fetch alone, with no package. Take every account-specific value (an id, a name, an address) from the input, never as a constant. Keep the test input to values that exist in any account, or that the call itself discovers.";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}${text.endsWith("\n") ? "" : "\n"}${ticks}`;
}

/** The current stock module as the model's starting point for a repair: its manifest and files. */
function startingPointOf(tool: StockWorkspaceTool): string {
  const manifest = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    hosts: tool.hosts,
    annotations: tool.annotations,
  };
  return [
    `Start from the current stock tool ${tool.vendor}__${tool.name} and change it as the goal says. Keep its name (${tool.name}) and its input unless the goal says otherwise. Its manifest:`,
    fence(JSON.stringify(manifest, null, 2)),
    `Its test input: ${JSON.stringify(tool.testInput)}`,
    ...tool.files.flatMap((file) => [`${file.path}:`, fence(file.content)]),
  ].join("\n\n");
}

/**
 * The manifest's hosts: every connection host the recorded proof reached or the module names, in
 * the starter's order. A stock tool runs over a connection whose hosts include all of these
 * (GRA-241), so it declares no more than it calls; the replay then proves it calls no other.
 */
export function hostsOf(
  recording: StockRecording,
  files: readonly { content: string }[],
  connectionHosts: readonly string[],
): string[] {
  const reached = new Set(recording.exchanges.map((exchange) => new URL(exchange.url).hostname));
  // A whole hostname, so `geocoding-api.open-meteo.com` does not name `api.open-meteo.com`.
  const names = (host: string) =>
    new RegExp(`(?<![\\w.-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`);
  const named = connectionHosts.filter((host) =>
    files.some((file) => names(host).test(file.content)),
  );
  const hosts = connectionHosts.filter((host) => reached.has(host) || named.includes(host));
  const outside = [...reached].filter((host) => !connectionHosts.includes(host));
  return [...hosts, ...outside];
}

async function exists(dir: string): Promise<boolean> {
  return readdir(dir).then(
    () => true,
    () => false,
  );
}

async function writeTool(dir: string, files: readonly { path: string; content: string }[]) {
  for (const file of files) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}

export async function buildStockTool(options: BuildOptions): Promise<BuildResult> {
  const progress: string[] = [];
  const refuse = (failure: string, message: string, extra: object = {}): BuildResult => ({
    ok: false,
    failure,
    message,
    progress,
    ...extra,
  });
  const workspace = options.workspace ?? STOCK_DIR;
  const { vendor } = options;

  const starter = starterVendorFor(vendor);
  if (!starter) {
    return refuse(
      "not_a_starter",
      `${vendor} is not a starter integration; stock tools are built for the starters alone (@graft/core's setup/starter-vendors.ts).`,
    );
  }
  const live: LiveConnection | null =
    options.connections[vendor] ??
    (starter.scheme === "none" ? { scheme: "none", schemeConfig: {}, credential: {} } : null);
  if (!live) {
    return refuse(
      "connection_missing",
      `There is no connection for ${vendor}. Give your own under GRAFT_STOCK_LIVE_CONNECTIONS, keyed "${vendor}": { "scheme": "${starter.scheme}", "credential": { … } }.`,
    );
  }
  // Every form of each credential value, encoded as the wire or a vendor's echo may carry it, so
  // nothing the command prints holds one (Greptile on #191).
  const rule = {
    secretValues: credentialForms(live.credential),
    secretFieldNames: secretFieldNamesFor(live.scheme, live.schemeConfig),
  };

  let current: StockWorkspaceTool | null = null;
  if (options.from) {
    const tools = await readStockWorkspace(workspace);
    current = tools.find((tool) => tool.vendor === vendor && tool.name === options.from) ?? null;
    if (!current) {
      return refuse(
        "from_not_found",
        `There is no stock tool ${vendor}__${options.from} in ${workspace} to start from.`,
      );
    }
  }

  // `acquire`'s own bound, said before any job rather than as its refusal.
  const goalLength = options.goal.trim().length;
  if (goalLength === 0 || goalLength > GOAL_MAX_LENGTH) {
    return refuse(
      "goal_invalid",
      `The goal comes to ${goalLength} characters once trimmed; acquire takes 1 to ${GOAL_MAX_LENGTH}.`,
    );
  }

  const hints = [`Documentation: ${starter.docsUrl}`, STOCK_RULES, options.hints?.trim()]
    .filter(Boolean)
    .join("\n\n");
  if (hints.length > HINTS_MAX_LENGTH) {
    return refuse(
      "hints_too_long",
      `The hints come to ${hints.length} characters; acquire takes ${HINTS_MAX_LENGTH}. Shorten --hints.`,
    );
  }

  const primaryHost = live.primaryHost ?? starter.primaryHost;
  const connectionHosts = [
    ...new Set([new URL(primaryHost).hostname, ...starter.hosts]),
  ] as string[];
  const upstreamFetch = options.upstreamFetch ?? createUpstreamFetch();
  const say = (line: string) => {
    progress.push(line);
    options.onProgress?.(line);
  };

  const loop = await runBuildLoop({
    connection: {
      vendor,
      displayName: starter.displayName,
      primaryHost,
      hosts: connectionHosts,
      live,
    },
    model: options.model,
    goal: options.goal,
    hints,
    extraHints: current ? startingPointOf(current) : null,
    upstreamFetch,
    readWebPage: options.readWebPage ?? ((args) => readWebPage(args)),
    maxAttempts: options.maxAttempts ?? 4,
    tokenCeiling: options.tokenCeiling ?? 400_000,
    onProgress: say,
  });
  if (!loop.ok) {
    const result = loop.status.result;
    // The job redacts by shape and by field name; it never held the credential's values, which
    // the build does, so they are taken out here before anything is printed.
    const failure =
      result && "failure" in result
        ? redactValue(result, rule).value
        : { failure: "job_failed", message: `The job ended ${loop.status.status}.` };
    return refuse(failure.failure, failure.message, {
      lastDiagnostics: "lastDiagnostics" in failure ? failure.lastDiagnostics : null,
    });
  }

  const { draft, success } = loop;
  const name = current?.name ?? draft.name;
  const wire = `${vendor}__${name}`;
  const manifestFile = draft.files.find((file) => file.path === "package.json");
  if (manifestFile) {
    let dependencies: Record<string, unknown> = {};
    try {
      dependencies =
        (JSON.parse(manifestFile.content) as { dependencies?: Record<string, unknown> })
          .dependencies ?? {};
    } catch {
      // A package.json that is not JSON declares nothing the publish admitted.
    }
    if (Object.keys(dependencies).length > 0) {
      return refuse(
        "packages_declared",
        `The draft declares ${Object.keys(dependencies).join(", ")}; a stock tool calls its vendor through ctx.fetch and declares no package. Nothing was written.`,
      );
    }
  }
  const moduleFiles = draft.files.filter(
    (file) =>
      file.path !== "package.json" &&
      ![MANIFEST_FILE, TEST_INPUT_FILE, RECORDING_FILE].includes(file.path),
  );
  const annotations = {
    readOnly: success.annotations.readOnlyHint,
    destructive: success.annotations.destructiveHint,
  };

  // The proof, recorded over every host of the connection; the manifest then declares the ones used.
  say(`Recording ${wire}'s proof: one dry run with its test input, through the proxy.`);
  const recorded = await recordStockProof(
    {
      vendor,
      name,
      description: draft.description,
      inputSchema: success.inputSchema,
      hosts: connectionHosts,
      files: moduleFiles,
      testInput: draft.testInput,
      sourceHash: "",
      annotations,
    },
    { connection: live, upstreamFetch, now: options.now },
  );
  if (!recorded.ok) {
    return refuse(
      "recording_failed",
      `${wire} was built, but its proof could not be recorded. Nothing was written.`,
      { problems: recorded.problems },
    );
  }
  const { recording } = recorded;
  const manifest = {
    name,
    description: draft.description,
    inputSchema: success.inputSchema,
    hosts: hostsOf(recording, moduleFiles, connectionHosts),
    annotations,
  };
  const files = [
    ...moduleFiles,
    { path: MANIFEST_FILE, content: json(manifest) },
    { path: TEST_INPUT_FILE, content: json(draft.testInput) },
    { path: RECORDING_FILE, content: formatRecording(recording) },
  ];

  const dir = join(workspace, vendor, name);
  const replaced = await exists(dir);
  // Said early, before the proofs; the swap claims the directory again, for a build that raced.
  if (replaced && !current) {
    return refuse(
      "tool_exists",
      `${wire} is already a stock tool. Rebuild it with --from ${name} to write its next version. Nothing was written.`,
    );
  }

  // Staged and formatted outside the workspace, then copied beside the tool it may replace and
  // proved there, as CI will prove it, before anything in the workspace moves.
  const stage = await mkdtemp(join(tmpdir(), "graft-stock-build-"));
  let incoming: string | null = null;
  try {
    const stagedDir = join(stage, vendor, name);
    await writeTool(stagedDir, files);
    const formatted = await (options.format ?? formatWithBiome)(stagedDir);
    if (formatted) say(formatted);

    // In the workspace, so the swap below is a rename on one file system. A dot-directory, which
    // `readStockWorkspace` never reads as a vendor, and gitignored, should a crash leave it behind.
    const nextRoot = join(workspace, INCOMING_PREFIX);
    try {
      // A workspace that does not exist yet is made, as the copy into it once made it.
      await mkdir(workspace, { recursive: true });
      incoming = await mkdtemp(nextRoot);
      await cp(stagedDir, join(incoming, vendor, name), { recursive: true });
    } catch (error) {
      return refuse(
        "write_failed",
        `${wire} was built and formatted, but it could not be copied into ${workspace}: ${(error as Error).message}. Nothing was replaced.`,
      );
    }

    const nextDir = join(incoming, vendor, name);
    // Read back as CI reads the workspace: the files as they will be committed.
    const [staged] = await readStockWorkspace(incoming);
    if (!staged) throw new Error("the staged tool did not read back");
    say(`Proving ${wire} as the harness will: the check, the test input and the replay.`);
    const read = await readStockRecording(staged, incoming);
    const problems = [
      ...(await proveCheck(staged)),
      ...proveTestInput(staged),
      ...(read.ok ? (await proveReplay(staged, read.recording)).problems : [read.problem]),
    ].map((problem) => redactValue(problem, rule).value);
    if (problems.length > 0) {
      return refuse(
        "harness_failed",
        `${wire} was built, but it does not pass the stock harness as it stands. Nothing was written.`,
        { problems },
      );
    }
    for (const note of read.ok ? jsonTextNotes(staged, read.recording) : []) {
      say(redactValue(note, rule).value);
    }

    // The swap: the current version aside, the proved one into its place, and the current one
    // back if that fails, so a failed repair leaves the tool it started from (Greptile on #191).
    const swapped = await swapInto(nextDir, dir, join(incoming, "previous"), {
      replace: current !== null,
    });
    if (!swapped.ok && swapped.exists) {
      return refuse(
        "tool_exists",
        `${wire} became a stock tool while this build ran. Rebuild it with --from ${name} to write its next version. Nothing was written.`,
      );
    }
    if (!swapped.ok) {
      return refuse(
        "write_failed",
        `${wire} was built and proved, but it could not be moved into ${dir}: ${swapped.message}. ${replaced ? "The current version is unchanged." : "Nothing was written."}`,
      );
    }
    say(
      replaced
        ? `Wrote ${wire}'s next version into ${dir}; the next boot appends it to the catalogue.`
        : `Wrote ${wire} into ${dir}.`,
    );
    return {
      ok: true,
      tool: wire,
      dir,
      replaced,
      files: files.map((file) => file.path).sort(),
      progress,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (incoming) await rm(incoming, { recursive: true, force: true });
  }
}

/** The prefix of the directory a build proves its tool in, inside the workspace. */
export const INCOMING_PREFIX = ".build-";

/**
 * Move `next` into `dir`, keeping what was at `dir` at `aside` until the move has happened and
 * putting it back if it did not. Both moves are renames within the workspace, so neither leaves a
 * half-copied directory; the copy that could fail midway was made beside them first.
 */
export async function swapInto(
  next: string,
  dir: string,
  aside: string,
  options: { replace: boolean },
): Promise<{ ok: true } | { ok: false; exists: boolean; message: string }> {
  // A new tool claims its directory with the rename itself, which refuses a non-empty target: a
  // second build of the same name that finished first wins, and this one is told so (Greptile on
  // #191), however long ago the earlier check ran.
  const hadCurrent = options.replace && (await exists(dir));
  try {
    await mkdir(dirname(dir), { recursive: true });
    if (hadCurrent) await rename(dir, aside);
  } catch (error) {
    return { ok: false, exists: false, message: (error as Error).message };
  }
  try {
    await rename(next, dir);
    return { ok: true };
  } catch (error) {
    if (hadCurrent) await rename(aside, dir);
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      exists: !hadCurrent && (code === "ENOTEMPTY" || code === "EEXIST"),
      message: (error as Error).message,
    };
  }
}
