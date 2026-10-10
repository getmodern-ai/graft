import type { CurrentStockTool } from "@graft/db/repo/stock";

import type { ServiceContext } from "../context";
import { starterProposal, starterVendorFor } from "../setup/starter-vendors";
import type { ToolAnnotations } from "../tool/tool.service";
import type { StockDeps } from "./stock.deps";

/**
 * The **stock catalogue** (ADR 0025; CONTEXT.md, *Stock tool*; GRA-238): the stock tools this
 * release ships, loaded from `@graft/stock`'s workspace at boot, and the reads the tool source
 * (`@graft/mcp`'s `tool-source.ts`) and the console make over it. Global: nothing here takes a
 * person, and the rows are reached through `@graft/db/repo/stock`'s unscoped statements.
 *
 * **The load is the boot's** (`apps/server/src/boot.ts`'s `loadStockOnStart`), in one transaction
 * under one advisory lock, so two replicas starting together append a version once. Per tool: the
 * row made when `(vendor, name)` is new; then, when no version of the tool has the source's hash,
 * the check is run and a version appended with the next number, the check's annotations on it
 * (ADR 0008: derived, never declared). An unchanged workspace writes nothing, and neither does an
 * older release's, since its hashes are all already there. A tool the check refuses is reported and skipped, and the rest load.
 *
 * **The integration list is the starter list** (GRA-224): a stock tool's `connect` is its vendor's
 * starter proposal (`starterProposal`), the arguments `request_connection` takes, so `find_tool`
 * can hand an agent the connect step for an integration the person has not connected.
 */

/** One stock tool as `@graft/stock` reads it off the workspace. */
export type StockToolSource = {
  vendor: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Every host the module calls (the manifest's). */
  hosts: string[];
  /** The module's files, the manifest and the test input not among them. */
  files: { path: string; content: string }[];
  testInput: Record<string, unknown>;
  /** A hash over the whole tool directory: what decides whether a version is appended. */
  sourceHash: string;
};

/** The check over one source, run only for a version about to be appended. */
export type StockCheck = (
  source: StockToolSource,
) => Promise<
  | { ok: true; annotations: ToolAnnotations; checkOutput: Record<string, unknown> }
  | { ok: false; problems: string[] }
>;

export type StockLoadReport = {
  /** How many stock tools the workspace holds. */
  tools: number;
  appended: { vendor: string; name: string; versionNumber: number }[];
  refused: { vendor: string; name: string; problems: string[] }[];
};

/** The `request_connection` arguments for an integration, a starter's proposal. */
export type StockConnectProposal = ReturnType<typeof starterProposal>;

/** A stock tool at its current version, as the tool source answers it. */
export type StockToolView = {
  stockToolId: string;
  stockVersionId: string;
  versionNumber: number;
  vendor: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  hosts: string[];
  files: { path: string; content: string }[];
  /** The check's result when the version was appended; the copy's version carries it. */
  checkOutput: Record<string, unknown>;
  /** The integration's connection proposal; null for a vendor no starter names. */
  connect: StockConnectProposal | null;
};

/** One stock tool as the console lists an integration's (`listStockToolsForVendor`). */
export type StockToolSummary = {
  name: string;
  /** The wire name, `<vendor>__<name>`, the copy keeps. */
  tool: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
};

export async function loadStockCatalogue(
  ctx: ServiceContext,
  sources: readonly StockToolSource[],
  check: StockCheck,
  deps: StockDeps,
): Promise<StockLoadReport> {
  return ctx.db.transaction(async (tx) => {
    await deps.lockStockCatalogue(tx);
    const report: StockLoadReport = { tools: sources.length, appended: [], refused: [] };
    for (const source of sources) {
      const key = { vendor: source.vendor, name: source.name };
      const tool =
        (await deps.insertStockTool(tx, { id: deps.newId(), ...key })) ??
        (await deps.findStockTool(tx, key));
      if (!tool)
        throw new Error(`stock tool ${source.vendor}/${source.name} was neither made nor found`);
      // A hash the tool already has, at any number, is never appended again: a replica of an older
      // release booting during a rolling deploy carries a hash a newer release superseded, and
      // appending it would make the older stock current. A release's stock is therefore newer than
      // every version before it only by being new bytes; a revert ships as a change.
      if (await deps.hasStockToolVersionWithHash(tx, tool.id, source.sourceHash)) continue;
      const latest = await deps.findLatestStockToolVersion(tx, tool.id);
      const verdict = await check(source);
      if (!verdict.ok) {
        report.refused.push({ ...key, problems: verdict.problems });
        continue;
      }
      const versionNumber = (latest?.versionNumber ?? 0) + 1;
      await deps.insertStockToolVersion(tx, {
        id: deps.newId(),
        stockToolId: tool.id,
        versionNumber,
        sourceHash: source.sourceHash,
        description: source.description,
        inputSchema: source.inputSchema,
        readOnly: verdict.annotations.readOnly,
        destructive: verdict.annotations.destructive,
        hosts: source.hosts,
        files: source.files,
        testInput: source.testInput,
        checkOutput: verdict.checkOutput,
      });
      report.appended.push({ ...key, versionNumber });
    }
    return report;
  });
}

function viewOf({ tool, version }: CurrentStockTool): StockToolView {
  const starter = starterVendorFor(tool.vendor);
  return {
    stockToolId: tool.id,
    stockVersionId: version.id,
    versionNumber: version.versionNumber,
    vendor: tool.vendor,
    name: tool.name,
    description: version.description,
    inputSchema: version.inputSchema,
    annotations: { readOnly: version.readOnly, destructive: version.destructive },
    hosts: version.hosts,
    files: version.files,
    checkOutput: version.checkOutput,
    connect: starter ? starterProposal(starter) : null,
  };
}

/** Every stock tool at its current version: what `find_tool` searches beside the toolbox. */
export async function listStockCatalogue(
  ctx: ServiceContext,
  deps: StockDeps,
): Promise<StockToolView[]> {
  return (await deps.listCurrentStockTools(ctx.db)).map(viewOf);
}

/** One stock tool at its current version, or null when the catalogue has none of that name. */
export async function describeStockTool(
  ctx: ServiceContext,
  key: { vendor: string; name: string },
  deps: StockDeps,
): Promise<StockToolView | null> {
  const row = await deps.findCurrentStockTool(ctx.db, key);
  return row ? viewOf(row) : null;
}

/**
 * One stock version by its id, as a person's copy recorded it, or null when the catalogue has no
 * such version: the hosts a copy's run is judged by are its own version's, not the catalogue's
 * current one's (GRA-241).
 */
export async function describeStockVersion(
  ctx: ServiceContext,
  stockVersionId: string,
  deps: StockDeps,
): Promise<StockToolView | null> {
  const row = await deps.findStockToolVersionById(ctx.db, stockVersionId);
  return row ? viewOf(row) : null;
}

/**
 * One integration's stock tools, by vendor slug, for the console (Setup v2): what each is called on
 * the wire, what it says it does, its annotations and the input it takes. No module, no hosts.
 */
export async function listStockToolsForVendor(
  ctx: ServiceContext,
  vendor: string,
  deps: StockDeps,
): Promise<StockToolSummary[]> {
  return (await deps.listCurrentStockToolsForVendor(ctx.db, vendor)).map(({ tool, version }) => ({
    name: tool.name,
    tool: `${tool.vendor}__${tool.name}`,
    description: version.description,
    annotations: { readOnly: version.readOnly, destructive: version.destructive },
    inputSchema: version.inputSchema,
  }));
}
