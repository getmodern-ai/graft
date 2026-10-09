import { describe, expect, it } from "vitest";

import { noteRunFailure, noteStockRun, stockOriginOf, withStockSignal } from "./stock-signal";

/**
 * A stock tool's run signal (GRA-244; ADR 0025): which stock tool and version a run of a person's
 * tool came from, and whether the code that ran is the person's remix over it; and the note a run
 * leaves for the call's event, which only a stock run leaves at all.
 */

const stock = (id: string, versionNumber: number, origin: string | null) => ({
  id,
  versionNumber,
  stockToolId: origin ? "stock_tool_1" : null,
  stockVersionId: origin,
});

describe("stockOriginOf", () => {
  it("names the stock version a copy carries, not a remix", () => {
    const v1 = stock("v1", 1, "stock_ver_1");
    expect(stockOriginOf(v1, [v1])).toEqual({
      toolId: "stock_tool_1",
      versionId: "stock_ver_1",
      remix: false,
    });
  });

  it("names the newest stock version below a version the person published, as a remix", () => {
    const v1 = stock("v1", 1, "stock_ver_1");
    const v2 = stock("v2", 2, "stock_ver_2");
    const v3 = stock("v3", 3, null);
    const v4 = stock("v4", 4, "stock_ver_4");
    expect(stockOriginOf(v3, [v4, v3, v2, v1])).toEqual({
      toolId: "stock_tool_1",
      versionId: "stock_ver_2",
      remix: true,
    });
  });

  it("answers null for a tool that never came from stock", () => {
    const v1 = stock("v1", 1, null);
    const v2 = stock("v2", 2, null);
    expect(stockOriginOf(v2, [v2, v1])).toBeNull();
    expect(stockOriginOf(v1, [v1])).toBeNull();
  });
});

describe("the note a run leaves for the call", () => {
  it("carries a stock run's origin and its failure, and nothing for any other run", async () => {
    const stocked = await withStockSignal(async () => {
      noteStockRun({ toolId: "stock_tool_1", versionId: "stock_ver_1", remix: false });
      noteRunFailure("threw", 503);
      return 1;
    });
    expect(stocked).toEqual({
      value: 1,
      stock: {
        toolId: "stock_tool_1",
        versionId: "stock_ver_1",
        remix: false,
        failureKind: "threw",
        vendorStatus: 503,
      },
    });
    const authored = await withStockSignal(async () => {
      noteStockRun(null);
      noteRunFailure("threw", 503);
      return 2;
    });
    expect(authored).toEqual({ value: 2, stock: null });
    // Outside a call, noting is a no-op.
    expect(() => noteStockRun(null)).not.toThrow();
  });
});
