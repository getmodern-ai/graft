import { describe, expect, it } from "vitest";

import { matchStockConnections, stockToolRunsOver } from "./stock-match";

const STOCK = {
  vendor: "open-meteo",
  hosts: ["geocoding-api.open-meteo.com", "api.open-meteo.com"],
};

const row = (
  id: string,
  vendor: string,
  hosts: string[],
  primaryHost = "https://unused.example",
) => ({
  id,
  vendor,
  hosts,
  primaryHost,
});

describe("stockToolRunsOver", () => {
  it("matches a connection reaching every host the manifest declares, whatever its slug", () => {
    expect(
      stockToolRunsOver(
        STOCK,
        row("c1", "weather-gateway", [
          "api.open-meteo.com",
          "geocoding-api.open-meteo.com",
          "x.example",
        ]),
      ),
    ).toBe(true);
  });

  it("counts the primary's host among the connection's, as the proxy does", () => {
    expect(
      stockToolRunsOver(
        STOCK,
        row("c1", "open-meteo", ["geocoding-api.open-meteo.com"], "https://api.open-meteo.com/v1"),
      ),
    ).toBe(true);
  });

  it("never matches a connection missing one host, even of the same slug", () => {
    expect(stockToolRunsOver(STOCK, row("c1", "open-meteo", ["api.open-meteo.com"]))).toBe(false);
  });

  it("compares hosts without regard to case", () => {
    expect(
      stockToolRunsOver(
        STOCK,
        row("c1", "x", ["API.open-meteo.com", "Geocoding-API.open-meteo.com"]),
      ),
    ).toBe(true);
  });
});

describe("matchStockConnections", () => {
  const both = ["geocoding-api.open-meteo.com", "api.open-meteo.com"];

  it("chooses the one connection whose hosts cover the manifest", () => {
    const decision = matchStockConnections(STOCK, [
      row("partial", "open-meteo", ["api.open-meteo.com"]),
      row("gateway", "weather", both),
    ]);
    expect(decision.chosen?.id).toBe("gateway");
    expect(decision.matches.map((match) => match.id)).toEqual(["gateway"]);
  });

  it("breaks a tie between host matches by the vendor slug", () => {
    const decision = matchStockConnections(STOCK, [
      row("gateway", "weather", both),
      row("keyring", "open-meteo", both),
    ]);
    expect(decision.chosen?.id).toBe("keyring");
    expect(decision.matches.map((match) => match.id)).toEqual(["keyring", "gateway"]);
  });

  it("chooses none when the slug does not break the tie", () => {
    const sameSlug = matchStockConnections(STOCK, [
      row("a", "open-meteo", both),
      row("b", "open-meteo", both),
    ]);
    expect(sameSlug.chosen).toBeNull();
    expect(sameSlug.matches.map((match) => match.id)).toEqual(["a", "b"]);

    const noSlug = matchStockConnections(STOCK, [row("a", "w1", both), row("b", "w2", both)]);
    expect(noSlug.chosen).toBeNull();
    expect(noSlug.matches).toHaveLength(2);
  });

  it("answers nothing when no connection covers the manifest", () => {
    expect(matchStockConnections(STOCK, [row("a", "open-meteo", ["api.open-meteo.com"])])).toEqual({
      matches: [],
      chosen: null,
    });
  });
});
