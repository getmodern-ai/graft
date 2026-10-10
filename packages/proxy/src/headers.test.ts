import { describe, expect, it } from "vitest";

import { unforwardedRequestHeaderNames } from "./headers";

/**
 * `unforwardedRequestHeaderNames` answers from the outgoing policy itself (GRA-271): what
 * `acquire`'s proof reads refuse is exactly what `forwardableRequestHeaders` would not send as set.
 */
describe("unforwardedRequestHeaderNames", () => {
  it("names what the policy drops or replaces, lower-cased, and passes a vendor's own header", () => {
    expect(
      unforwardedRequestHeaderNames([
        "Notion-Version",
        "Authorization",
        "x-api-key",
        "Cookie",
        "Host",
        "Content-Length",
        "Accept-Encoding",
        "Transfer-Encoding",
        "traceparent",
        "X-Forwarded-For",
        "Proxy-Foo",
        "x-blaxel-request-id",
        "Linear-Client",
      ]),
    ).toEqual([
      "authorization",
      "x-api-key",
      "cookie",
      "host",
      "content-length",
      "accept-encoding",
      "transfer-encoding",
      "traceparent",
      "x-forwarded-for",
      "proxy-foo",
      "x-blaxel-request-id",
    ]);
  });

  it("names a string that is not a header name, and answers nothing for nothing", () => {
    expect(unforwardedRequestHeaderNames(["not a name"])).toEqual(["not a name"]);
    expect(unforwardedRequestHeaderNames([])).toEqual([]);
  });
});
