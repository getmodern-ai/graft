import { describe, expect, it } from "vitest";

import { declaredLength, readCapped } from "./body";

/** The bounded read on its own: the cap, and the deadline that stops a body that never ends. */

function chunks(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

/** A body that sends one chunk and then never closes — a slow or stalled caller. */
function stalled(first: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
    },
  });
}

describe("readCapped", () => {
  it("reads a body to its end", async () => {
    const read = await readCapped(chunks("ab", "cd"), 10);
    expect(read).toEqual({ ok: true, bytes: new TextEncoder().encode("abcd") });
  });

  it("answers an empty body for no stream", async () => {
    expect(await readCapped(null, 10)).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it("stops at the cap without buffering the excess", async () => {
    expect(await readCapped(chunks("abcdef", "ghijkl"), 8)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("gives up on a body that never finishes when the deadline passes", async () => {
    const read = await readCapped(stalled("partial"), 1024, AbortSignal.timeout(20));
    expect(read).toEqual({ ok: false, reason: "aborted" });
  });

  it("refuses at once when the deadline has already passed", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await readCapped(chunks("x"), 10, controller.signal)).toEqual({
      ok: false,
      reason: "aborted",
    });
  });
});

describe("declaredLength", () => {
  it("reads a well-formed Content-Length and nothing else", () => {
    expect(declaredLength(new Headers({ "content-length": "42" }))).toBe(42);
    expect(declaredLength(new Headers({ "content-length": "-1" }))).toBeNull();
    expect(declaredLength(new Headers({ "content-length": "many" }))).toBeNull();
    expect(declaredLength(new Headers())).toBeNull();
  });
});
