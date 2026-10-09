import { describe, expect, it } from "vitest";

import { decideStockAdvance, stockLineageOf, type VersionOrigin } from "./stock-advance.decision";

const fromStock = (stockVersionId: string, stockToolId = "st_weather"): VersionOrigin => ({
  stockToolId,
  stockVersionId,
});
const byAgent: VersionOrigin = { stockToolId: null, stockVersionId: null };
const catalogueAt = (stockVersionId: string, versionNumber: number) => ({
  stockToolId: "st_weather",
  stockVersionId,
  versionNumber,
});

describe("stockLineageOf", () => {
  it("is stock when every version came from stock", () => {
    expect(stockLineageOf([fromStock("sv1")])).toBe("stock");
    expect(stockLineageOf([fromStock("sv2"), fromStock("sv1")])).toBe("stock");
  });

  it("is a remix once any version came from the agent, whichever came first", () => {
    expect(stockLineageOf([byAgent, fromStock("sv1")])).toBe("remix");
    expect(stockLineageOf([fromStock("sv2"), byAgent, fromStock("sv1")])).toBe("remix");
  });

  it("is authored when no version came from stock, or there is no version", () => {
    expect(stockLineageOf([byAgent])).toBe("authored");
    expect(stockLineageOf([byAgent, byAgent])).toBe("authored");
    expect(stockLineageOf([])).toBe("authored");
  });
});

describe("decideStockAdvance", () => {
  it("advances an untouched copy when the catalogue holds a version it never took", () => {
    expect(
      decideStockAdvance({ versions: [fromStock("sv1")], catalogue: catalogueAt("sv2", 2) }),
    ).toEqual({
      action: "advance",
      stockToolId: "st_weather",
      stockVersionId: "sv2",
      stockVersionNumber: 2,
    });
  });

  it("advances past several stock versions at once, to the catalogue's current", () => {
    expect(
      decideStockAdvance({
        versions: [fromStock("sv2"), fromStock("sv1")],
        catalogue: catalogueAt("sv5", 5),
      }),
    ).toMatchObject({ action: "advance", stockVersionId: "sv5" });
  });

  it("stays when the copy already holds the catalogue's current version", () => {
    expect(
      decideStockAdvance({
        versions: [fromStock("sv2"), fromStock("sv1")],
        catalogue: catalogueAt("sv2", 2),
      }),
    ).toEqual({ action: "stay", reason: "current" });
  });

  it("never advances a remix, however far the catalogue moved", () => {
    expect(
      decideStockAdvance({
        versions: [byAgent, fromStock("sv1")],
        catalogue: catalogueAt("sv9", 9),
      }),
    ).toEqual({ action: "stay", reason: "remix" });
    // A stock version on top of an agent's does not undo the remix.
    expect(
      decideStockAdvance({
        versions: [fromStock("sv2"), byAgent, fromStock("sv1")],
        catalogue: catalogueAt("sv3", 3),
      }),
    ).toEqual({ action: "stay", reason: "remix" });
  });

  it("never touches a tool the agent authored, even one of a stock tool's name", () => {
    expect(decideStockAdvance({ versions: [byAgent], catalogue: catalogueAt("sv2", 2) })).toEqual({
      action: "stay",
      reason: "authored",
    });
    expect(decideStockAdvance({ versions: [], catalogue: catalogueAt("sv2", 2) })).toEqual({
      action: "stay",
      reason: "authored",
    });
  });

  it("stays when the catalogue has no such tool", () => {
    expect(decideStockAdvance({ versions: [fromStock("sv1")], catalogue: null })).toEqual({
      action: "stay",
      reason: "not_in_catalogue",
    });
  });

  it("stays when the copy came from another stock tool than the catalogue's of this name", () => {
    expect(
      decideStockAdvance({
        versions: [fromStock("sv1", "st_other")],
        catalogue: catalogueAt("sv2", 2),
      }),
    ).toEqual({ action: "stay", reason: "other_stock_tool" });
  });
});
