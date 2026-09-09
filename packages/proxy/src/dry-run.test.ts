import { describe, expect, it } from "vitest";

import {
  buildDryRunPreview,
  DRY_RUN_HEADER,
  DRY_RUN_PREVIEW_STATUS,
  isSafeMethod,
  schemeHeaderNames,
} from "./dry-run";
import { SCHEMES, SNOWFLAKE_TOKEN_TYPE_HEADER } from "./schemes";

/**
 * The pure half of the dry run (CONTEXT.md, *Dry run*). What the preview says and what it must
 * never say, and which header names each scheme would have added. The ladder that decides *when* a
 * preview is answered is `app.test.ts`'s.
 */

describe("isSafeMethod", () => {
  it("lets GET and HEAD through in any case, and nothing else", () => {
    for (const method of ["GET", "HEAD", "get", "head"]) expect(isSafeMethod(method)).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "QUERY", "post"]) {
      expect(isSafeMethod(method), method).toBe(false);
    }
  });
});

describe("buildDryRunPreview", () => {
  const url = new URL("https://api.vendor.example/v1/orders?expand=lines");

  it("carries the method, the host, the resolved path, whether a query was present, and the marker fields", () => {
    const preview = buildDryRunPreview({ method: "POST", url, headerNames: [], body: null });

    expect(preview).toMatchObject({
      dryRun: true,
      intercepted: true,
      request: { method: "POST", host: "api.vendor.example", path: "/v1/orders", hasQuery: true },
    });
    // The query's *values* never appear — a scheme may put a key there.
    expect(JSON.stringify(preview)).not.toContain("expand");
  });

  it("names the host without its port, as the connection declares it", () => {
    const preview = buildDryRunPreview({
      method: "POST",
      url: new URL("https://api.vendor.example:8443/x"),
      headerNames: [],
      body: null,
    });
    expect(preview.request.host).toBe("api.vendor.example");
  });

  it("reports no query for a bare path and for a lone question mark", () => {
    for (const href of [
      "https://api.vendor.example/v1/orders",
      "https://api.vendor.example/v1/x?",
    ]) {
      const preview = buildDryRunPreview({
        method: "POST",
        url: new URL(href),
        headerNames: [],
        body: null,
      });
      expect(preview.request.hasQuery, href).toBe(false);
    }
  });

  it("lower-cases, de-duplicates and sorts the header names", () => {
    const preview = buildDryRunPreview({
      method: "PUT",
      url,
      headerNames: ["Content-Type", "x-demo-key", "Accept", "content-type", "accept-encoding"],
      body: null,
    });

    expect(preview.request.headerNames).toEqual([
      "accept",
      "accept-encoding",
      "content-type",
      "x-demo-key",
    ]);
  });

  it("returns a UTF-8 body as text with its byte count", () => {
    const body = new TextEncoder().encode('{"name":"Zoë","qty":2}');
    const preview = buildDryRunPreview({ method: "POST", url, headerNames: [], body });

    expect(preview.request).toMatchObject({
      body: '{"name":"Zoë","qty":2}',
      bodyEncoding: "utf-8",
      bodyBytes: body.byteLength,
    });
    // "Zoë" is four bytes and three characters: the count is bytes, as the wide event's is.
    expect(preview.request.bodyBytes).toBe(23);
  });

  it("returns a body that is not UTF-8 as base64, saying so", () => {
    const body = new Uint8Array([0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47]);
    const preview = buildDryRunPreview({ method: "POST", url, headerNames: [], body });

    expect(preview.request).toMatchObject({
      body: Buffer.from(body).toString("base64"),
      bodyEncoding: "base64",
      bodyBytes: 7,
    });
  });

  it("describes a write with no body as an empty UTF-8 body of zero bytes", () => {
    for (const body of [null, new Uint8Array(0)]) {
      const preview = buildDryRunPreview({ method: "DELETE", url, headerNames: [], body });
      expect(preview.request).toMatchObject({ body: "", bodyEncoding: "utf-8", bodyBytes: 0 });
    }
  });
});

describe("schemeHeaderNames", () => {
  const callers = () => new Headers({ "content-type": "application/json", accept: "*/*" });

  it.each([
    ["api_key_header", { headerName: "X-Vendor-Auth", prefix: "Token" }, ["x-vendor-auth"]],
    ["bearer", {}, ["authorization"]],
    ["basic", {}, ["authorization"]],
    [
      "oauth2_client_credentials",
      { tokenUrl: "https://auth.vendor.example/token" },
      ["authorization"],
    ],
    ["unleashed_hmac", {}, ["api-auth-id", "api-auth-signature", "client-type"]],
    ["snowflake_keypair_jwt", {}, ["authorization", SNOWFLAKE_TOKEN_TYPE_HEADER]],
  ] as const)("adds the header names %s would set, and no value", (scheme, config, added) => {
    const result = schemeHeaderNames(callers(), SCHEMES[scheme], config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const name of added) expect(result.headerNames, name).toContain(name);
    expect(result.headerNames).toContain("content-type");
    expect(result.headerNames).toContain("accept");
  });

  it("adds nothing for a scheme that signs the query rather than a header", () => {
    const result = schemeHeaderNames(callers(), SCHEMES.api_key_query, {
      queryParam: "api_key",
    });

    // `Headers` iterates its names sorted; the builder sorts again, so the order here is incidental.
    expect(result).toEqual({ ok: true, headerNames: ["accept", "content-type"] });
  });

  it("leaves the caller's headers untouched", () => {
    const headers = callers();

    schemeHeaderNames(headers, SCHEMES.api_key_query, { queryParam: "api_key" });
    schemeHeaderNames(headers, SCHEMES.unleashed_hmac, {});

    expect([...headers.keys()]).toEqual(["accept", "content-type"]);
  });

  /** The live path would answer 409 after decrypting; the dry run says the same thing sooner. */
  it("refuses a scheme whose configuration is incomplete, as a live call would", () => {
    expect(schemeHeaderNames(callers(), SCHEMES.api_key_header, {})).toEqual({
      ok: false,
      reason: "credential_incomplete",
      message: "scheme configuration is missing headerName",
    });
  });
});

describe("the constants the runner and the README name", () => {
  it("are the documented header and status", () => {
    expect(DRY_RUN_HEADER).toBe("x-graft-dry-run");
    expect(DRY_RUN_PREVIEW_STATUS).toBe(202);
  });
});
