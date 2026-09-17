import { describe, expect, it } from "vitest";
import {
  LINK_CALLBACK_PATH,
  LINK_STATE_TTL_MS,
  linkCallbackMessage,
  linkCallbackRedirect,
  linkCallbackUri,
  readLinkCallbackSearch,
} from "./link.rules";
import { signLinkState, verifyLinkState } from "./link-state";
import { signOAuthState } from "./oauth-consent";

/**
 * The link's two pure halves (GRA-59): the outcome the return route writes and the console reads
 * — one shape, two functions that round-trip — and the signed state the provider carries back,
 * held to the same rules as a consent's (`oauth-consent.test.ts`).
 */

const NOW = new Date("2026-09-17T10:00:00Z");
const SECRET = "link-state-test-secret-that-is-long-enough-32";
const PAYLOAD = {
  pendingActionId: "pa_1",
  personId: "person_1",
  provider: "pipedream",
  expiresAt: NOW.getTime() + LINK_STATE_TTL_MS,
  nonce: "n1",
};

describe("the link callback's outcome", () => {
  it("writes the console route's query and reads it back, leaving a null id out rather than writing null", () => {
    const url = linkCallbackRedirect("http://console.graft.test/", {
      status: "connected",
      pendingActionId: "pa_1",
      connectionId: "conn_1",
      message: "Gmail is connected — the console updates on its own.",
    });
    expect(url.startsWith("http://console.graft.test/link/callback?")).toBe(true);
    const search = Object.fromEntries(new URL(url).searchParams);
    expect(readLinkCallbackSearch(search)).toEqual({
      status: "connected",
      pendingActionId: "pa_1",
      connectionId: "conn_1",
      message: "Gmail is connected — the console updates on its own.",
    });

    const failed = new URL(
      linkCallbackRedirect("http://console.graft.test", {
        status: "failed",
        pendingActionId: null,
        connectionId: null,
        message: "x",
      }),
    );
    expect(failed.searchParams.has("pendingActionId")).toBe(false);
    expect(failed.searchParams.has("connectionId")).toBe(false);
  });

  it("reads anything unknown as failed with no ids, so a hand-typed address settles nothing", () => {
    expect(readLinkCallbackSearch({ status: "yes", pendingActionId: 1, message: 2 })).toEqual({
      status: "failed",
      pendingActionId: null,
      connectionId: null,
      message: "",
    });
    expect(linkCallbackMessage(readLinkCallbackSearch({ status: "declined" }))).toEqual({
      type: "graft:link",
      status: "declined",
      pendingActionId: null,
      connectionId: null,
      message: "",
    });
  });

  it("the return URI is the server's origin plus the path, a trailing slash not doubled", () => {
    expect(linkCallbackUri("http://localhost:3000/")).toBe(
      `http://localhost:3000${LINK_CALLBACK_PATH}`,
    );
    expect(linkCallbackUri("https://app.getgraft.ai")).toBe(
      "https://app.getgraft.ai/api/providers/link/callback",
    );
  });
});

describe("the link's signed state", () => {
  it("round-trips a payload under the secret", () => {
    const state = signLinkState(PAYLOAD, SECRET);
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyLinkState(state, SECRET, NOW)).toEqual({ ok: true, payload: PAYLOAD });
  });

  it("refuses a tampered, malformed, expired or foreign state, naming which", () => {
    const state = signLinkState(PAYLOAD, SECRET);
    const [encoded, mark] = state.split(".");
    expect(verifyLinkState(`${encoded}.${mark?.slice(1)}x`, SECRET, NOW)).toMatchObject({
      ok: false,
      reason: "tampered",
    });
    expect(verifyLinkState(state, "another-secret-that-is-long-enough-32", NOW)).toMatchObject({
      ok: false,
      reason: "tampered",
    });
    const other = Buffer.from(JSON.stringify({ ...PAYLOAD, personId: "person_2" })).toString(
      "base64url",
    );
    expect(verifyLinkState(`${other}.${mark}`, SECRET, NOW)).toMatchObject({
      ok: false,
      reason: "tampered",
    });
    expect(verifyLinkState("", SECRET, NOW)).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyLinkState("nodot", SECRET, NOW)).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyLinkState(state, SECRET, new Date(PAYLOAD.expiresAt + 1))).toMatchObject({
      ok: false,
      reason: "expired",
    });
    // A consent's state, signed under the same secret, is not a link's.
    const consent = signOAuthState(
      {
        connectionId: "conn_1",
        personId: "person_1",
        pendingActionId: "pa_1",
        expiresAt: PAYLOAD.expiresAt,
        nonce: "n",
      },
      SECRET,
    );
    expect(verifyLinkState(consent, SECRET, NOW).ok).toBe(false);
  });
});
