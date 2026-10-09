import { describe, expect, it } from "vitest";

import { stockHarnessModeFrom } from "./mode";

describe("stockHarnessModeFrom", () => {
  it("replays by default, and with GRAFT_STOCK_LIVE unset, empty or 0", () => {
    expect(stockHarnessModeFrom({})).toEqual({ kind: "replay", tools: null });
    expect(stockHarnessModeFrom({ GRAFT_STOCK_LIVE: "0" })).toEqual({
      kind: "replay",
      tools: null,
    });
  });

  it("narrows to the tools GRAFT_STOCK_TOOLS names", () => {
    expect(
      stockHarnessModeFrom({
        GRAFT_STOCK_TOOLS: " open-meteo__current-weather, github__list-issues",
      }),
    ).toEqual({
      kind: "replay",
      tools: ["open-meteo__current-weather", "github__list-issues"],
    });
  });

  it("goes live with the connections GRAFT_STOCK_LIVE_CONNECTIONS gives, keyed by vendor", () => {
    expect(
      stockHarnessModeFrom({
        GRAFT_STOCK_LIVE: "1",
        GRAFT_STOCK_LIVE_CONNECTIONS: JSON.stringify({
          github: { scheme: "bearer", credential: { token: "t" } },
        }),
      }),
    ).toEqual({
      kind: "live",
      tools: null,
      connections: { github: { scheme: "bearer", schemeConfig: {}, credential: { token: "t" } } },
    });
    expect(stockHarnessModeFrom({ GRAFT_STOCK_LIVE: "1" })).toEqual({
      kind: "live",
      tools: null,
      connections: {},
    });
  });

  it("refuses a malformed switch with a sentence that never repeats the secret", () => {
    expect(stockHarnessModeFrom({ GRAFT_STOCK_LIVE: "yes" })).toEqual({
      error: 'GRAFT_STOCK_LIVE is 1 or unset, not "yes"',
    });
    const bad = stockHarnessModeFrom({
      GRAFT_STOCK_LIVE: "1",
      GRAFT_STOCK_LIVE_CONNECTIONS: "{secret-token-value",
    });
    expect(bad).toEqual({ error: "GRAFT_STOCK_LIVE_CONNECTIONS is not JSON" });
    expect(
      stockHarnessModeFrom({
        GRAFT_STOCK_LIVE: "1",
        GRAFT_STOCK_LIVE_CONNECTIONS: JSON.stringify({
          github: { scheme: "magic", credential: {} },
        }),
      }),
    ).toEqual({
      error: "GRAFT_STOCK_LIVE_CONNECTIONS.github.scheme must be one of the proxy's schemes",
    });
  });
});
