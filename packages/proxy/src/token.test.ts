import { describe, expect, it } from "vitest";

import { extractToken, INBOUND_AUTH_HEADERS, scrubToken, TOKEN_HEADERS } from "./token";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Where a token may ride, in order — and what is not a token at all. */
describe("extractToken", () => {
  it.each([
    [{ authorization: "Bearer abc.def.ghi" }, "abc.def.ghi"],
    [{ authorization: "bearer   abc.def.ghi  " }, "abc.def.ghi"],
    [{ authorization: `Basic ${b64("abc.def.ghi:")}` }, "abc.def.ghi"],
    [{ authorization: `basic ${b64(":abc.def.ghi")}` }, "abc.def.ghi"],
    [{ authorization: "abc.def.ghi" }, "abc.def.ghi"],
    [{ "x-api-key": "abc.def.ghi" }, "abc.def.ghi"],
    [{ "x-graft-token": " abc.def.ghi " }, "abc.def.ghi"],
  ])("reads %o", (headers, expected) => {
    expect(extractToken(new Headers(headers))).toBe(expected);
  });

  it("prefers Authorization, then x-api-key, then x-graft-token", () => {
    expect(
      extractToken(
        new Headers({ authorization: "Bearer one", "x-api-key": "two", "x-graft-token": "three" }),
      ),
    ).toBe("one");
    expect(extractToken(new Headers({ "x-api-key": "two", "x-graft-token": "three" }))).toBe("two");
  });

  /** A basic pair with both halves filled is somebody's real credential, not the token. */
  it("treats an Authorization of another scheme as no token", () => {
    expect(extractToken(new Headers({ authorization: `Basic ${b64("user:pass")}` }))).toBeNull();
    expect(extractToken(new Headers({ authorization: "Digest realm=x" }))).toBeNull();
    expect(
      extractToken(
        new Headers({ authorization: `Basic ${b64("user:pass")}`, "x-graft-token": "t" }),
      ),
    ).toBe("t");
  });

  it("treats a basic pair that is not user:password, or whose token half has spaces, as no token", () => {
    expect(extractToken(new Headers({ authorization: `Basic ${b64("nocolon")}` }))).toBeNull();
    expect(extractToken(new Headers({ authorization: `Basic ${b64("has space:")}` }))).toBeNull();
    expect(extractToken(new Headers({ authorization: `Basic ${b64(":")}` }))).toBeNull();
  });

  it("answers null for no headers or blank values", () => {
    expect(extractToken(new Headers())).toBeNull();
    expect(extractToken(new Headers({ authorization: "   ", "x-api-key": "" }))).toBeNull();
  });

  it("strips every position a token is read from", () => {
    for (const name of TOKEN_HEADERS) {
      expect(INBOUND_AUTH_HEADERS).toContain(name);
    }
    expect(TOKEN_HEADERS).toEqual(["authorization", "x-api-key", "x-graft-token"]);
    expect(INBOUND_AUTH_HEADERS).toContain("cookie");
  });
});

/** The by-value sweep behind the by-name strip: the token reaches no vendor whatever it rode in. */
describe("scrubToken", () => {
  const TOKEN = "tok.en.value";

  it("drops any header whose value carries the token, and keeps the rest", () => {
    const headers = new Headers({
      apikey: TOKEN,
      "x-auth-token": `Token ${TOKEN}`,
      "x-keep": "keep",
      accept: "application/json",
    });
    scrubToken(headers, new URL("https://api.vendor.example/x"), TOKEN);

    expect([...headers.keys()].sort()).toEqual(["accept", "x-keep"]);
  });

  it("drops any query parameter whose value carries the token, and keeps the rest", () => {
    const url = new URL(`https://api.vendor.example/x?key=${TOKEN}&limit=5&access_token=${TOKEN}`);
    scrubToken(new Headers(), url, TOKEN);

    expect(url.search).toBe("?limit=5");
  });

  it("drops only the offending value when a parameter is repeated", () => {
    const url = new URL(`https://api.vendor.example/x?ids=1&ids=${TOKEN}&ids=2`);
    scrubToken(new Headers(), url, TOKEN);

    expect(url.searchParams.getAll("ids")).toEqual(["1", "2"]);
  });

  it("leaves a query with nothing of the token in it byte for byte", () => {
    const url = new URL("https://api.vendor.example/x?a=%2F&b=a%20b&c");
    scrubToken(new Headers(), url, TOKEN);

    expect(url.search).toBe("?a=%2F&b=a%20b&c");
  });
});
