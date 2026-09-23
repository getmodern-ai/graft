import { describe, expect, it } from "vitest";

import type { PendingAction } from "./pending-action-queries";
import { connectAskView, SETUP_CONNECT_LABEL } from "./setup-vendors";

const action = (id: string) => ({ id }) as PendingAction;

describe("connectAskView", () => {
  it("draws the record's ask while it is open, and waits while the list loads", () => {
    const open = [action("pa_other"), action("pa_1")];
    expect(connectAskView("pa_1", open)).toEqual({ kind: "card", action: open[1] });
    expect(connectAskView("pa_1", undefined)).toEqual({ kind: "loading" });
  });

  it("settles once the ask has left the open list, or when the record names none", () => {
    expect(connectAskView("pa_1", [action("pa_other")])).toEqual({ kind: "settling" });
    expect(connectAskView(null, [action("pa_1")])).toEqual({ kind: "settling" });
  });
});

describe("SETUP_CONNECT_LABEL", () => {
  it("names every connect kind in sentence case", () => {
    for (const label of Object.values(SETUP_CONNECT_LABEL)) {
      expect(label).toMatch(/^[A-Z][a-z ]+$/);
    }
  });
});
