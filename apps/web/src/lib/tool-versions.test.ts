import { describe, expect, it } from "vitest";

import type { ToolboxTool } from "./connection-queries";
import { toolVersionLines, versionOrigin } from "./tool-versions";

type Version = ToolboxTool["versions"][number];

const version = (overrides: Partial<Version>): Version => ({
  id: "ver_1",
  versionNumber: 1,
  current: false,
  createdAt: "2026-10-09T00:00:00.000Z",
  origin: "stock",
  stockVersionNumber: 1,
  ...overrides,
});

describe("versionOrigin", () => {
  it("names the ready-made version a stock version was copied from", () => {
    expect(versionOrigin(version({ stockVersionNumber: 3 }))).toBe("Ready-made v3");
  });

  it("says ready-made alone where the catalogue no longer holds the number", () => {
    expect(versionOrigin(version({ stockVersionNumber: null }))).toBe("Ready-made");
  });

  it("says the agent wrote a version it published", () => {
    expect(versionOrigin(version({ origin: "agent", stockVersionNumber: null }))).toBe(
      "Written by your agent",
    );
  });
});

describe("toolVersionLines", () => {
  it("lists newest first, each with its origin and the current one marked", () => {
    expect(
      toolVersionLines({
        versions: [
          version({ id: "ver_1", versionNumber: 1, stockVersionNumber: 1 }),
          version({
            id: "ver_3",
            versionNumber: 3,
            origin: "agent",
            stockVersionNumber: null,
            current: true,
          }),
          version({ id: "ver_2", versionNumber: 2, stockVersionNumber: 2 }),
        ],
      }),
    ).toEqual([
      { id: "ver_3", label: "v3", origin: "Written by your agent", current: true },
      { id: "ver_2", label: "v2", origin: "Ready-made v2", current: false },
      { id: "ver_1", label: "v1", origin: "Ready-made v1", current: false },
    ]);
  });
});
