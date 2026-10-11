import { describe, expect, it } from "vitest";

import { connectionChoicesSent, connectionChoicesShown } from "./connection-choices";

const BOTH_TICKED = { approveBuild: true, allowVendor: true };

describe("connectionChoicesShown", () => {
  it("shows both lines on an agent's ask", () => {
    expect(connectionChoicesShown({ origin: "agent" })).toEqual(BOTH_TICKED);
  });

  it("shows the tools line in Setup and leaves the build approval to Build", () => {
    expect(connectionChoicesShown({ origin: "setup" })).toEqual({
      approveBuild: false,
      allowVendor: true,
    });
  });

  it("shows both on a widening, which Setup draws as the inbox does", () => {
    expect(connectionChoicesShown({ origin: "setup", widens: true })).toEqual(BOTH_TICKED);
  });
});

describe("connectionChoicesSent", () => {
  it("sends a grant only when the person was shown the choice (GRA-274)", () => {
    const hidden = { approveBuild: false, allowVendor: false };
    expect(connectionChoicesSent(hidden, BOTH_TICKED)).toEqual(hidden);
    expect(connectionChoicesSent(connectionChoicesShown({ origin: "setup" }), BOTH_TICKED)).toEqual(
      { approveBuild: false, allowVendor: true },
    );
  });

  it("sends what the person left ticked on a line they saw", () => {
    expect(connectionChoicesSent(BOTH_TICKED, { approveBuild: true, allowVendor: false })).toEqual({
      approveBuild: true,
      allowVendor: false,
    });
    expect(connectionChoicesSent(BOTH_TICKED, BOTH_TICKED)).toEqual(BOTH_TICKED);
  });
});
