import { describe, expect, it } from "vitest";

import {
  canDisconnect,
  linkOutcome,
  linkSocialMessage,
  linkSocialUrls,
  MAX_NAME_LENGTH,
  nameDraftProblem,
  readSettingsSearch,
  socialRows,
  themeChoiceOf,
  unlinkFailure,
} from "./account-settings";

const password = { id: "a-cred", providerId: "credential" };
const google = { id: "a-google", providerId: "google" };
const github = { id: "a-github", providerId: "github" };

describe("canDisconnect", () => {
  it("refuses the last sign-in method of a social-only account", () => {
    expect(canDisconnect([google], ["google", "github"], "google")).toBe(false);
  });

  it("allows a provider beside a password", () => {
    expect(canDisconnect([password, google], ["google"], "google")).toBe(true);
  });

  it("allows a provider beside another configured provider", () => {
    expect(canDisconnect([google, github], ["google", "github"], "google")).toBe(true);
  });

  it("does not count a linked provider the server no longer names", () => {
    expect(canDisconnect([google, github], ["google"], "google")).toBe(false);
  });
});

describe("socialRows", () => {
  it("draws only the providers the server names, in its order", () => {
    expect(socialRows([password, github], ["github"]).map((row) => row.provider)).toEqual([
      "github",
    ]);
    expect(socialRows([], [])).toEqual([]);
  });

  it("names the linked account and whether it may go", () => {
    expect(socialRows([google], ["google", "github"])).toEqual([
      { provider: "google", accountId: "a-google", canDisconnect: false },
      { provider: "github", accountId: null, canDisconnect: false },
    ]);
    expect(socialRows([password, google], ["google"])).toEqual([
      { provider: "google", accountId: "a-google", canDisconnect: true },
    ]);
  });
});

describe("linkSocialUrls", () => {
  it("returns to Settings naming the provider on both legs", () => {
    expect(linkSocialUrls("https://graft.test", "github")).toEqual({
      callbackURL: "https://graft.test/settings?provider=github",
      errorCallbackURL: "https://graft.test/settings?provider=github",
    });
  });
});

describe("linkSocialMessage", () => {
  it("names an account another person holds", () => {
    expect(linkSocialMessage("account_already_linked_to_different_user", "GitHub")).toBe(
      "That GitHub account already signs in to a different Graft account.",
    );
  });

  it("falls back to a retry for an unknown code", () => {
    expect(linkSocialMessage("something_else", "Google")).toBe(
      "Could not connect Google. Try again.",
    );
  });
});

describe("readSettingsSearch and linkOutcome", () => {
  it("keeps only a known provider and a non-empty error", () => {
    expect(readSettingsSearch({ provider: "google", error: "access_denied", x: 1 })).toEqual({
      provider: "google",
      error: "access_denied",
    });
    expect(readSettingsSearch({ provider: "myspace", error: "" })).toEqual({});
  });

  it("reads the error leg as a refusal naming the provider", () => {
    expect(linkOutcome({ provider: "google", error: "access_denied" })).toEqual({
      kind: "error",
      message: "Connecting Google was cancelled.",
    });
  });

  it("reads the success leg as connected", () => {
    expect(linkOutcome({ provider: "github" })).toEqual({
      kind: "success",
      message: "GitHub is connected. You can sign in with it now.",
    });
  });

  it("says nothing for a bare error or an empty search", () => {
    expect(linkOutcome({ error: "access_denied" })).toBeNull();
    expect(linkOutcome({})).toBeNull();
  });
});

describe("unlinkFailure", () => {
  it("asks for a fresh session", () => {
    expect(unlinkFailure({ code: "SESSION_NOT_FRESH" }, "Google")).toBe(
      "To disconnect Google, sign out and sign in again first.",
    );
  });

  it("explains the last account", () => {
    expect(unlinkFailure({ code: "FAILED_TO_UNLINK_LAST_ACCOUNT" }, "GitHub")).toContain(
      "only way to sign in",
    );
  });

  it("keeps Better Auth's own sentence otherwise", () => {
    expect(unlinkFailure({ code: "X", message: "Nope." }, "Google")).toBe("Nope.");
  });
});

describe("nameDraftProblem", () => {
  it("refuses a blank name", () => {
    expect(nameDraftProblem("   ")).toBe("Enter your name.");
  });

  it("refuses a name past the bound, judged trimmed", () => {
    expect(nameDraftProblem(`  ${"a".repeat(MAX_NAME_LENGTH)}  `)).toBeNull();
    expect(nameDraftProblem("a".repeat(MAX_NAME_LENGTH + 1))).toBe("Use at most 100 characters.");
  });
});

describe("themeChoiceOf", () => {
  it("reads an unknown or unread theme as system", () => {
    expect(themeChoiceOf(undefined)).toBe("system");
    expect(themeChoiceOf("sepia")).toBe("system");
    expect(themeChoiceOf("dark")).toBe("dark");
  });
});
