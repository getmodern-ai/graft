import {
  LINK_CALLBACK_MESSAGE_TYPE,
  linkCallbackMessage,
  linkCallbackRedirect,
  readLinkCallbackSearch,
} from "@graft/core/connection/link.rules";
import { describe, expect, it } from "vitest";

import { linkOutcomeOf, readLinkMessage } from "./provider-link";

/**
 * The link's message filter (GRA-59), on both sides: what the console's `/link/callback` route
 * posts, as the server's redirect wrote it, and what the waiting card takes as its own — this ask's,
 * from the console's own origin, of the shape the route posts, and nothing else.
 */

const ORIGIN = "http://console.graft.test";
const MESSAGE = {
  type: LINK_CALLBACK_MESSAGE_TYPE,
  status: "connected" as const,
  pendingActionId: "pa_1",
  connectionId: "conn_1",
  message: "Gmail is connected through broker — the console updates on its own.",
};

describe("readLinkMessage", () => {
  it("reads the callback route's message from the console's own origin about this ask", () => {
    expect(readLinkMessage({ origin: ORIGIN, data: MESSAGE }, ORIGIN, "pa_1")).toEqual(MESSAGE);
    expect(
      readLinkMessage(
        { origin: ORIGIN, data: { ...MESSAGE, status: "failed", connectionId: null, message: 1 } },
        ORIGIN,
        "pa_1",
      ),
    ).toEqual({ ...MESSAGE, status: "failed", connectionId: null, message: "" });
  });

  it("ignores another origin, another shape, another ask and an unknown status", () => {
    expect(
      readLinkMessage({ origin: "http://evil.example", data: MESSAGE }, ORIGIN, "pa_1"),
    ).toBeNull();
    expect(readLinkMessage({ origin: ORIGIN, data: "connected" }, ORIGIN, "pa_1")).toBeNull();
    expect(
      readLinkMessage(
        { origin: ORIGIN, data: { ...MESSAGE, type: "graft:oauth" } },
        ORIGIN,
        "pa_1",
      ),
    ).toBeNull();
    expect(readLinkMessage({ origin: ORIGIN, data: MESSAGE }, ORIGIN, "pa_2")).toBeNull();
    expect(
      readLinkMessage({ origin: ORIGIN, data: { ...MESSAGE, status: "maybe" } }, ORIGIN, "pa_1"),
    ).toBeNull();
  });

  it("reads the message the callback route posts, as the server's redirect wrote it", () => {
    const url = new URL(
      linkCallbackRedirect(ORIGIN, {
        status: "connected",
        pendingActionId: "pa_1",
        connectionId: "conn_1",
        message: MESSAGE.message,
      }),
    );
    const posted = linkCallbackMessage(
      readLinkCallbackSearch(Object.fromEntries(url.searchParams)),
    );
    expect(readLinkMessage({ origin: ORIGIN, data: posted }, ORIGIN, "pa_1")).toEqual(MESSAGE);
  });
});

describe("linkOutcomeOf", () => {
  it("reads a settled ask with a connection as connected, and one without as a decline — never as a success", () => {
    expect(linkOutcomeOf({ settled: true, connectionId: "conn_1" })).toEqual({
      outcome: "connected",
      message: "",
      connectionId: "conn_1",
    });
    expect(linkOutcomeOf({ settled: true, connectionId: null })).toMatchObject({
      outcome: "declined",
      connectionId: null,
      message: expect.stringContaining("declined"),
    });
  });
});
