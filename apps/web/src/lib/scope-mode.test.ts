import { agentScopeMode } from "@graft/db/schema/agent";
import { describe, expect, it } from "vitest";

import {
  readScopeMode,
  SCOPE_MODE_DESCRIPTION,
  SCOPE_MODE_ITEMS,
  SCOPE_MODE_LABEL,
  scopeBodyFor,
  scopeDirty,
} from "./scope-mode";

describe("the scope mode's labels", () => {
  // The column's enum is the source; a mode added there without a label here would render as
  // nothing in the Select, which is the one control the mode has.
  it("has one label, one description and one item for every mode the column can carry, in sentence case", () => {
    expect(Object.keys(SCOPE_MODE_LABEL).sort()).toEqual([...agentScopeMode].sort());
    expect(Object.keys(SCOPE_MODE_DESCRIPTION).sort()).toEqual([...agentScopeMode].sort());
    expect(SCOPE_MODE_ITEMS.map((item) => item.value).sort()).toEqual([...agentScopeMode].sort());
    for (const mode of agentScopeMode) {
      expect(SCOPE_MODE_LABEL[mode]).toMatch(/^[A-Z][^.]*$/);
      expect(SCOPE_MODE_ITEMS.find((item) => item.value === mode)?.label).toBe(
        SCOPE_MODE_LABEL[mode],
      );
    }
  });

  /** ADR 0007 as amended 2026-09-19: the default is offered first, and its sentence says what it reaches and what still asks. */
  it("offers all connections first and says it reaches future connections while approvals still ask", () => {
    expect(SCOPE_MODE_ITEMS[0]?.value).toBe("all");
    expect(SCOPE_MODE_DESCRIPTION.all).toContain("every one you add later");
    expect(SCOPE_MODE_DESCRIPTION.all).toContain("Approvals still ask once per connection");
  });

  it("reads a Select's value back as a mode and nothing else", () => {
    expect(readScopeMode("all")).toBe("all");
    expect(readScopeMode("listed")).toBe("listed");
    expect(readScopeMode("some")).toBeNull();
    expect(readScopeMode(null)).toBeNull();
  });
});

describe("the scope write's body", () => {
  it("carries no list under all and the draft as the list under listed", () => {
    expect(scopeBodyFor("all", new Set(["conn_1"]))).toEqual({ mode: "all" });
    expect(scopeBodyFor("listed", new Set(["conn_2", "conn_1"]))).toEqual({
      mode: "listed",
      connectionIds: ["conn_2", "conn_1"],
    });
  });
});

describe("whether the scope section is dirty", () => {
  const saved = { mode: "listed" as const, connectionIds: new Set(["conn_1", "conn_2"]) };

  it("is clean when nothing moved, and dirty when the mode did", () => {
    expect(
      scopeDirty(saved, { mode: "listed", connectionIds: new Set(["conn_2", "conn_1"]) }),
    ).toBe(false);
    expect(scopeDirty(saved, { mode: "all", connectionIds: saved.connectionIds })).toBe(true);
    expect(
      scopeDirty(
        { mode: "all", connectionIds: new Set() },
        { mode: "listed", connectionIds: new Set() },
      ),
    ).toBe(true);
  });

  it("under listed compares the sets; under all ignores whatever the hidden picker holds", () => {
    expect(scopeDirty(saved, { mode: "listed", connectionIds: new Set(["conn_1"]) })).toBe(true);
    expect(
      scopeDirty(saved, { mode: "listed", connectionIds: new Set(["conn_1", "conn_2", "conn_3"]) }),
    ).toBe(true);
    const open = { mode: "all" as const, connectionIds: new Set(["conn_1"]) };
    expect(scopeDirty(open, { mode: "all", connectionIds: new Set(["conn_9"]) })).toBe(false);
  });
});
