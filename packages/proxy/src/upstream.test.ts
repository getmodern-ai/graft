import type { LookupAddress } from "node:dns";

import { describe, expect, it } from "vitest";

import {
  guardedLookup,
  isPrivateAddressFailure,
  isTimeoutFailure,
  PrivateAddressError,
  type ResolveAll,
} from "./upstream";

/**
 * The resolver the socket is opened through — "refused at resolution" (GRA-1, "The proxy and the
 * capability token"), tested against a scripted DNS so no name is looked up.
 */

function resolver(answers: Record<string, LookupAddress[] | Error>): ResolveAll {
  return (hostname, callback) => {
    const answer = answers[hostname];
    if (answer instanceof Error) return callback(answer, []);
    callback(null, answer ?? []);
  };
}

function lookup(resolve: ResolveAll, hostname: string, options: { all?: boolean } = {}) {
  return new Promise<unknown[]>((done) => {
    guardedLookup(resolve)(hostname, options, (...args) => done(args));
  });
}

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const MIXED = [
  { address: "93.184.216.34", family: 4 },
  { address: "169.254.169.254", family: 4 },
];

describe("guardedLookup", () => {
  it("hands a public address through, in both callback shapes", async () => {
    const resolve = resolver({ "api.vendor.example": PUBLIC });

    expect(await lookup(resolve, "api.vendor.example")).toEqual([null, "93.184.216.34", 4]);
    expect(await lookup(resolve, "api.vendor.example", { all: true })).toEqual([null, PUBLIC]);
  });

  it("refuses a name that resolves to a private address", async () => {
    const [error] = await lookup(
      resolver({ "evil.example": [{ address: "10.0.0.1", family: 4 }] }),
      "evil.example",
    );

    expect(error).toBeInstanceOf(PrivateAddressError);
    expect((error as PrivateAddressError).address).toBe("10.0.0.1");
  });

  /** One private answer among public ones is still a route to the metadata service. */
  it("refuses the whole lookup when any answer is private", async () => {
    const [error] = await lookup(resolver({ "mixed.example": MIXED }), "mixed.example");

    expect(error).toBeInstanceOf(PrivateAddressError);
  });

  it("refuses the IPv6 private and mapped forms", async () => {
    const [ula] = await lookup(resolver({ a: [{ address: "fd00::1", family: 6 }] }), "a");
    const [mapped] = await lookup(
      resolver({ b: [{ address: "::ffff:10.0.0.1", family: 6 }] }),
      "b",
    );
    const [ok] = await lookup(
      resolver({ c: [{ address: "2606:4700:4700::1111", family: 6 }] }),
      "c",
    );

    expect(ula).toBeInstanceOf(PrivateAddressError);
    expect(mapped).toBeInstanceOf(PrivateAddressError);
    expect(ok).toBeNull();
  });

  it("passes a resolver error through and treats no answer as a refusal", async () => {
    const failure = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    const [error] = await lookup(resolver({ gone: failure }), "gone");
    const [empty] = await lookup(resolver({}), "nothing.example");

    expect(error).toBe(failure);
    expect(empty).toBeInstanceOf(PrivateAddressError);
  });
});

describe("failure classification through a cause chain", () => {
  it("finds the resolver's refusal where undici wraps it", () => {
    const wrapped = new TypeError("fetch failed", {
      cause: new PrivateAddressError("h", "10.0.0.1"),
    });
    expect(isPrivateAddressFailure(wrapped)).toBe(true);
    expect(isPrivateAddressFailure(new TypeError("fetch failed"))).toBe(false);
    expect(isPrivateAddressFailure("nope")).toBe(false);
  });

  it("finds the timeout abort", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isTimeoutFailure(timeout)).toBe(true);
    expect(isTimeoutFailure(new Error("x", { cause: timeout }))).toBe(true);
    expect(isTimeoutFailure(new Error("ECONNRESET"))).toBe(false);
  });
});
