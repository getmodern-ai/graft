import { fetch as undiciFetch } from "undici";
import { describe, expect, it } from "vitest";

import {
  checkUrl,
  defaultWebPageDeps,
  htmlToText,
  readWebPage,
  type WebPageDeps,
} from "./web-page";

/**
 * The page reader's guards, without a network: the URL rule, the resolved-address rule, the
 * same-host redirect rule, and the window a long page comes back in. The proxy's own address table
 * decides what is private (`@graft/proxy/public-host`), so the cases here are the ones a reader
 * adds on top: the scheme, credentials in the URL, a loopback name, a name that resolves privately.
 */

function deps(overrides: Partial<WebPageDeps> = {}): WebPageDeps {
  return {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    pinTo: () => ({ dispatcher: undefined, close: async () => {} }),
    fetch: async () =>
      new Response("<html><title>Docs</title><body><p>Hello</p></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    ...overrides,
  };
}

describe("checkUrl", () => {
  it("refuses http, credentials, loopback and private literals, and names for here", () => {
    for (const bad of [
      "http://docs.vendor.example/",
      "https://user:pw@docs.vendor.example/",
      "https://127.0.0.1/",
      "https://10.1.2.3/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00::1]/",
      "https://localhost/",
      "https://metadata.google.internal/",
      "https://intranet/",
      "not a url",
    ]) {
      expect("error" in checkUrl(bad), bad).toBe(true);
    }
    expect("url" in checkUrl("https://docs.vendor.example/api")).toBe(true);
  });
});

describe("readWebPage", () => {
  it("refuses a public name that resolves to a private address, before fetching", async () => {
    let fetched = false;
    const result = await readWebPage(
      { url: "https://docs.vendor.example/" },
      deps({
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
        fetch: async () => {
          fetched = true;
          return new Response("");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("10.0.0.5") });
    expect(fetched).toBe(false);
  });

  it("reports a redirect to another host rather than following it", async () => {
    const result = await readWebPage(
      { url: "https://docs.vendor.example/" },
      deps({
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
      }),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("another host") });
  });

  it("returns the page as text with a title, and a long page in windows", async () => {
    const page = await readWebPage({ url: "https://docs.vendor.example/" }, deps());
    expect(page).toMatchObject({ ok: true, title: "Docs", content: "Hello", nextOffset: null });

    const long = "word ".repeat(10_000);
    const first = await readWebPage(
      { url: "https://docs.vendor.example/" },
      deps({
        fetch: async () => new Response(long, { headers: { "content-type": "text/plain" } }),
      }),
    );
    expect(first).toMatchObject({ ok: true, truncated: true, offset: 0 });
    if (!first.ok) throw new Error(first.error);
    const second = await readWebPage(
      { url: "https://docs.vendor.example/", offset: first.nextOffset ?? 0 },
      deps({
        fetch: async () => new Response(long, { headers: { "content-type": "text/plain" } }),
      }),
    );
    expect(second).toMatchObject({ ok: true, offset: first.nextOffset });
  });

  it("fetches with undici's own fetch, the copy the pinned Agent belongs to (GRA-91)", () => {
    // The global fetch is Node's bundled undici, a different copy: handed the package's `Agent` as
    // its dispatcher it fails every read with "invalid onRequestStart method". The module's header
    // has the argument; this pins the pairing so a tidy-up cannot put the global back.
    expect(defaultWebPageDeps.fetch).toBe(undiciFetch);
    expect(defaultWebPageDeps.fetch).not.toBe(globalThis.fetch);
  });
});

describe("htmlToText", () => {
  it("drops scripts, keeps list items as lines and decodes entities after the tags are gone", () => {
    const { title, text } = htmlToText(
      "<html><head><title>T &amp; U</title><script>x()</script></head><body><ul><li>one</li><li>two &lt;b&gt;</li></ul></body></html>",
    );
    expect(title).toBe("T & U");
    expect(text).toBe("- one\n- two <b>");
  });
});
