import { describe, expect, it } from "vitest";

import {
  followable,
  type Hop,
  isRedirect,
  MAX_REDIRECT_HOPS,
  nextHop,
  scrubReturnedRedirect,
} from "./redirects";
import { SCHEMES } from "./schemes";
import type { UpstreamResponse } from "./types";

/**
 * The redirect policy on its own. `app.test.ts` proves the same rules through the proxy — a
 * redirect returned, a hop inside the host set followed under the flag, the hop cap, a 307 with a
 * body, a 303 after a POST; this suite pins the seam `forward` calls, `nextHop`, and the method
 * table `followable` implements, one status at a time.
 */

const HOSTS: ReadonlySet<string> = new Set(["api.vendor.example", "files.vendor.example"]);

function redirect(status: number, location: string | null): UpstreamResponse {
  const headers = new Headers();
  if (location !== null) headers.set("location", location);
  return { status, statusText: "", headers, body: null };
}

function hop(method: string, body: Uint8Array | null = null): Hop {
  return { method, url: new URL("https://api.vendor.example/v1/orders"), body };
}

describe("isRedirect", () => {
  it("names the five statuses a browser would follow and nothing else", () => {
    expect([301, 302, 303, 307, 308].every(isRedirect)).toBe(true);
    expect([200, 300, 304, 305, 306, 400].some(isRedirect)).toBe(false);
  });
});

describe("nextHop", () => {
  it("is null while the break-glass flag is off, whatever the redirect", () => {
    const next = nextHop(
      redirect(302, "/v1/elsewhere"),
      hop("GET"),
      HOSTS,
      { followRedirects: false },
      0,
    );
    expect(next).toBeNull();
  });

  it("is null for a response that is not a redirect, even under the flag", () => {
    const next = nextHop(
      redirect(200, "/v1/elsewhere"),
      hop("GET"),
      HOSTS,
      { followRedirects: true },
      0,
    );
    expect(next).toBeNull();
  });

  it("is null once the hop cap is reached, so the last redirect is returned", () => {
    const under = nextHop(
      redirect(302, "/v1/next"),
      hop("GET"),
      HOSTS,
      { followRedirects: true },
      MAX_REDIRECT_HOPS - 1,
    );
    const at = nextHop(
      redirect(302, "/v1/next"),
      hop("GET"),
      HOSTS,
      { followRedirects: true },
      MAX_REDIRECT_HOPS,
    );
    expect(under?.url.pathname).toBe("/v1/next");
    expect(at).toBeNull();
  });

  it("hands a redirect inside the host set under the flag to followable", () => {
    const next = nextHop(
      redirect(302, "/v1/next?page=2"),
      hop("GET"),
      HOSTS,
      { followRedirects: true },
      0,
    );
    expect(next).toEqual({
      method: "GET",
      url: new URL("https://api.vendor.example/v1/next?page=2"),
      body: null,
    });
  });
});

describe("followable", () => {
  it("refuses a Location without one, outside the set, downgraded, on another port, or malformed", () => {
    expect(followable(redirect(302, null), hop("GET"), HOSTS)).toBeNull();
    expect(followable(redirect(302, "https://elsewhere.example/x"), hop("GET"), HOSTS)).toBeNull();
    expect(followable(redirect(302, "http://api.vendor.example/x"), hop("GET"), HOSTS)).toBeNull();
    expect(
      followable(redirect(302, "https://api.vendor.example:8443/x"), hop("GET"), HOSTS),
    ).toBeNull();
    expect(followable(redirect(302, "https://"), hop("GET"), HOSTS)).toBeNull();
  });

  /** ADR 0010's host set: any declared host is still the connection's, so the hop is still pinned. */
  it("follows a Location on another host in the set", () => {
    const next = followable(
      redirect(302, "https://files.vendor.example/download/1"),
      hop("GET"),
      HOSTS,
    );
    expect(next?.url.href).toBe("https://files.vendor.example/download/1");
  });

  it("follows an upgrade to https, since nothing is lost by it", () => {
    const from: Hop = { method: "GET", url: new URL("http://api.vendor.example/x"), body: null };
    expect(followable(redirect(302, "https://api.vendor.example/y"), from, HOSTS)?.url.href).toBe(
      "https://api.vendor.example/y",
    );
  });

  it("refuses a Location whose host is not a public address, even when it is in the set", () => {
    const privateHosts = new Set(["10.0.0.1"]);
    const from: Hop = { method: "GET", url: new URL("https://10.0.0.1/orders"), body: null };
    expect(followable(redirect(302, "/elsewhere"), from, privateHosts)).toBeNull();
  });

  it("resolves a relative Location against the hop that answered and drops the fragment", () => {
    const next = followable(redirect(302, "../v2/orders#frag"), hop("GET"), HOSTS);
    expect(next?.url.href).toBe("https://api.vendor.example/v2/orders");
  });

  it("turns a 303 into a GET whatever the method was", () => {
    expect(
      followable(redirect(303, "/v1/next"), hop("POST", new Uint8Array(2)), HOSTS),
    ).toMatchObject({
      method: "GET",
      body: null,
    });
    expect(followable(redirect(303, "/v1/next"), hop("GET"), HOSTS)?.method).toBe("GET");
  });

  it("turns a 301 or 302 into a GET for anything but GET and HEAD", () => {
    for (const status of [301, 302]) {
      expect(
        followable(redirect(status, "/v1/next"), hop("POST", new Uint8Array(2)), HOSTS)?.method,
      ).toBe("GET");
      expect(followable(redirect(status, "/v1/next"), hop("DELETE"), HOSTS)?.method).toBe("GET");
      expect(followable(redirect(status, "/v1/next"), hop("GET"), HOSTS)?.method).toBe("GET");
      expect(followable(redirect(status, "/v1/next"), hop("HEAD"), HOSTS)?.method).toBe("HEAD");
    }
  });

  it("keeps the method on a 307 or 308, and only when there is no body to resend", () => {
    for (const status of [307, 308]) {
      expect(followable(redirect(status, "/v1/next"), hop("DELETE"), HOSTS)).toMatchObject({
        method: "DELETE",
        body: null,
      });
      expect(
        followable(redirect(status, "/v1/next"), hop("POST", new Uint8Array(2)), HOSTS),
      ).toBeNull();
    }
  });
});

describe("scrubReturnedRedirect", () => {
  const from = new URL("https://api.vendor.example/v1/orders?api_key=secret-value");

  it("removes what the scheme put on the URL and writes the resolved Location back", () => {
    const headers = new Headers({ location: "/v1/orders/?api_key=secret-value&page=2" });
    scrubReturnedRedirect(headers, from, SCHEMES.api_key_query, { queryParam: "api_key" });
    expect(headers.get("location")).toBe("https://api.vendor.example/v1/orders/?page=2");
  });

  it("leaves a Location with nothing of ours in it exactly as the vendor sent it", () => {
    const headers = new Headers({ location: "/v1/orders/?page=2" });
    scrubReturnedRedirect(headers, from, SCHEMES.api_key_query, { queryParam: "api_key" });
    expect(headers.get("location")).toBe("/v1/orders/?page=2");
  });

  it("does nothing for a scheme that writes no URL, and for a malformed or absent Location", () => {
    const untouched = new Headers({ location: "/v1/orders/?api_key=secret-value" });
    scrubReturnedRedirect(untouched, from, SCHEMES.bearer, {});
    expect(untouched.get("location")).toBe("/v1/orders/?api_key=secret-value");

    const malformed = new Headers({ location: "https://" });
    scrubReturnedRedirect(malformed, from, SCHEMES.api_key_query, { queryParam: "api_key" });
    expect(malformed.get("location")).toBe("https://");

    const absent = new Headers();
    scrubReturnedRedirect(absent, from, SCHEMES.api_key_query, { queryParam: "api_key" });
    expect(absent.has("location")).toBe(false);
  });
});
