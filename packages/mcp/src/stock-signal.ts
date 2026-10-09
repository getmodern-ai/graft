import { AsyncLocalStorage } from "node:async_hooks";

import { listToolVersions, type ServiceContext, type ToolDeps } from "@graft/core";
import type { ToolVersionRow } from "@graft/db/repo/tool";

import type { RunFailureKind } from "./run";

/**
 * The signal a stock tool's runs give (GRA-244; ADR 0025, "failures across people's runs feed the
 * same alert, by the failure's shape and never a person's data"). A run of a person's copy of a
 * stock tool, or of a remix of one, notes the stock tool and stock version it came from, and on a
 * failure the failure's kind and the last vendor error status, onto the tool call it ran under; the
 * call's event (`tools.ts`'s `toolCallEvent`) carries them under `stock`, and the server puts them
 * on the wide event and on `tool_called`. Nothing of the input, the output or the vendor's body is
 * ever noted. A run of a tool that never came from stock notes nothing, so its event is unchanged.
 *
 * Carried as `blobs.ts`'s tally is, in async-local storage set by the one dispatch point, because
 * the run is several calls below the event and its answer's keys are the module's.
 */

/** The stock tool and version a run came from, and whether the code that ran is the person's own. */
export type StockOrigin = { toolId: string; versionId: string; remix: boolean };

/** What a call's event carries of a stock run: the origin, and on a failure its shape. */
export type StockSignal = StockOrigin & { failureKind?: RunFailureKind; vendorStatus?: number };

type Note = { stock: StockSignal | null };

const notes = new AsyncLocalStorage<Note>();

/** Run one tool call with a fresh note in reach of the run inside it. */
export async function withStockSignal<T>(
  work: () => Promise<T>,
): Promise<{ value: T; stock: StockSignal | null }> {
  const note: Note = { stock: null };
  const value = await notes.run(note, work);
  return { value, stock: note.stock };
}

/** A run read its version: note its stock origin, or nothing for a tool that never came from stock. */
export function noteStockRun(origin: StockOrigin | null): void {
  const note = notes.getStore();
  if (!note || !origin) return;
  note.stock = { ...origin };
}

/** A stock run failed: its kind and the vendor's last error status. A no-op for any other run. */
export function noteRunFailure(kind: RunFailureKind, vendorStatus?: number): void {
  const stock = notes.getStore()?.stock;
  if (!stock) return;
  stock.failureKind = kind;
  if (vendorStatus !== undefined) stock.vendorStatus = vendorStatus;
}

type VersionOrigin = Pick<ToolVersionRow, "versionNumber" | "stockToolId" | "stockVersionId">;

/**
 * Where the version that ran came from. A version carrying a stock origin is a stock version, run
 * as stock (`remix: false`). One without is the person's: a remix when an earlier version of the
 * same tool carries an origin, which is then the newest such below it, and null otherwise. "Remix"
 * here is of the code that ran, so a pointer moved back onto a stock version reads as stock.
 */
export function stockOriginOf(
  ran: VersionOrigin,
  versions: readonly VersionOrigin[],
): StockOrigin | null {
  if (ran.stockToolId && ran.stockVersionId) {
    return { toolId: ran.stockToolId, versionId: ran.stockVersionId, remix: false };
  }
  const below = versions
    .filter((version) => version.versionNumber < ran.versionNumber)
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .find((version) => version.stockToolId && version.stockVersionId);
  return below?.stockToolId && below.stockVersionId
    ? { toolId: below.stockToolId, versionId: below.stockVersionId, remix: true }
    : null;
}

/**
 * `stockOriginOf` over the tool's versions, read only when they can matter: a version with an origin
 * answers alone, and a first version without one is a tool that never came from stock, since a copy
 * is always its tool's first version (`@graft/publish`'s `copyStockVersion`).
 */
export async function readStockOrigin(
  ctx: ServiceContext,
  personId: string,
  ran: VersionOrigin & { toolId: string },
  deps: ToolDeps,
): Promise<StockOrigin | null> {
  if (ran.stockToolId || ran.versionNumber <= 1) return stockOriginOf(ran, []);
  const versions = await listToolVersions(ctx, { personId }, ran.toolId, deps);
  return stockOriginOf(ran, versions);
}
