import { describe, expect, it } from "vitest";

import {
  buildApprovalConnectionName,
  buildApprovalTitle,
  buildApprovalWithdrawnSentence,
} from "./build-approval-copy";

/** A build approval's words on the agent's page (GRA-295; ADR 0008 as amended 2026-09-18). */

describe("buildApprovalTitle", () => {
  it("names a starter integration by its own name, not the connection's", () => {
    expect(buildApprovalTitle({ vendor: "gmail", displayName: "Gmail (work)" })).toBe(
      "Build its own Gmail tools",
    );
  });

  it("names any other integration by the connection's name", () => {
    expect(buildApprovalTitle({ vendor: "demo_orders", displayName: "Demo Orders" })).toBe(
      "Build its own Demo Orders tools",
    );
  });
});

describe("buildApprovalConnectionName", () => {
  it("shows the connection's name where it tells two accounts apart", () => {
    expect(buildApprovalConnectionName({ vendor: "gmail", displayName: "Gmail (work)" })).toBe(
      "Gmail (work)",
    );
  });

  it("is null where it is the integration's name", () => {
    expect(buildApprovalConnectionName({ vendor: "gmail", displayName: "Gmail" })).toBeNull();
    expect(
      buildApprovalConnectionName({ vendor: "demo_orders", displayName: "Demo Orders" }),
    ).toBeNull();
  });
});

describe("buildApprovalWithdrawnSentence", () => {
  it("says the next build asks", () => {
    expect(buildApprovalWithdrawnSentence({ vendor: "gmail", displayName: "Gmail (work)" })).toBe(
      "The next tool it builds with Gmail (work) asks you first.",
    );
  });
});
