import { describe, expect, it } from "vitest";

import {
  validateCredentialFields,
  validateHostSet,
  validateOAuthClient,
  validateSchemeConfig,
  validateVendor,
} from "./connection.rules";

/** Total functions over strings; every case is a sentence a person would see, or the normalised value. */

describe("validateVendor", () => {
  it("accepts a kebab-case slug and refuses anything else", () => {
    expect(validateVendor("unleashed")).toBeNull();
    expect(validateVendor("google-workspace")).toBeNull();
    for (const bad of ["", "Unleashed", "google_workspace", "-x", "x".repeat(65)]) {
      expect(validateVendor(bad), bad).not.toBeNull();
    }
  });
});

describe("validateHostSet", () => {
  it("normalises the primary to origin plus path and adds its hostname to the set", () => {
    expect(validateHostSet("https://API.Vendor.Example/v2/", ["Files.vendor.example"])).toEqual({
      ok: true,
      primaryHost: "https://api.vendor.example/v2",
      hosts: ["api.vendor.example", "files.vendor.example"],
    });
  });

  it("de-duplicates and lower-cases the additional hosts, keeping a port", () => {
    const verdict = validateHostSet("https://api.vendor.example", [
      "api.vendor.example",
      "Files.Vendor.Example:8443",
      "files.vendor.example:8443",
    ]);
    expect(verdict).toEqual({
      ok: true,
      primaryHost: "https://api.vendor.example",
      hosts: ["api.vendor.example", "files.vendor.example:8443"],
    });
  });

  it("refuses http, credentials in the URL, a query, a fragment and a non-URL", () => {
    for (const bad of [
      "http://api.vendor.example",
      "https://user:pass@api.vendor.example",
      "https://api.vendor.example/?key=1",
      "https://api.vendor.example/#frag",
      "not a url",
    ]) {
      const verdict = validateHostSet(bad, []);
      expect(verdict.ok, bad).toBe(false);
    }
  });

  /** The address rule (ADR 0010), applied here at registration and again by the proxy at resolution. */
  it("refuses private, loopback, link-local, metadata and internal hosts, primary or additional", () => {
    for (const host of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "localhost",
      "db.internal",
      "[::1]",
    ]) {
      const asPrimary = validateHostSet(`https://${host}`, []);
      expect(asPrimary.ok, host).toBe(false);
      if (!asPrimary.ok) expect(asPrimary.problem).toContain("not a public host");
    }
    const asExtra = validateHostSet("https://api.vendor.example", ["169.254.169.254"]);
    expect(asExtra.ok).toBe(false);
  });

  it("refuses an additional host that is not a hostname", () => {
    for (const bad of ["https://files.vendor.example", "files.vendor.example/path", "files"]) {
      const verdict = validateHostSet("https://api.vendor.example", [bad]);
      expect(verdict.ok, bad).toBe(false);
    }
  });
});

describe("validateSchemeConfig", () => {
  it("accepts each scheme's parameters and refuses a missing or unknown one by name", () => {
    expect(validateSchemeConfig("api_key_header", { headerName: "x-api-key" })).toBeNull();
    expect(
      validateSchemeConfig("api_key_header", { headerName: "x-api-key", prefix: "Token" }),
    ).toBeNull();
    expect(validateSchemeConfig("api_key_header", {})).toContain("headerName");
    expect(validateSchemeConfig("bearer", { headerName: "x" })).toContain("headerName");
    expect(validateSchemeConfig("api_key_query", { queryParam: "key" })).toBeNull();
    expect(
      validateSchemeConfig("snowflake_keypair_jwt", { account: "acme", user: "svc" }),
    ).toBeNull();
    expect(validateSchemeConfig("snowflake_keypair_jwt", { account: "acme" })).toContain("user");
  });

  it("refuses an empty or non-string value", () => {
    expect(validateSchemeConfig("api_key_header", { headerName: "" })).toContain("headerName");
    expect(validateSchemeConfig("api_key_header", { headerName: 3 })).toContain("headerName");
  });

  it("holds the header name to a token and asks for a prefix on a bare Authorization header", () => {
    expect(validateSchemeConfig("api_key_header", { headerName: "x api key" })).toContain(
      "letters",
    );
    expect(validateSchemeConfig("api_key_header", { headerName: "Authorization" })).toContain(
      "prefix",
    );
    expect(
      validateSchemeConfig("api_key_header", { headerName: "Authorization", prefix: "Token" }),
    ).toBeNull();
  });

  it("holds the OAuth2 token URL to https on a public host, and clientAuth to its two values", () => {
    expect(
      validateSchemeConfig("oauth2_client_credentials", {
        tokenUrl: "https://id.vendor.example/token",
      }),
    ).toBeNull();
    expect(
      validateSchemeConfig("oauth2_client_credentials", {
        tokenUrl: "http://id.vendor.example/token",
      }),
    ).toContain("https");
    expect(
      validateSchemeConfig("oauth2_client_credentials", { tokenUrl: "https://10.0.0.1/token" }),
    ).toContain("not a public host");
    expect(
      validateSchemeConfig("oauth2_client_credentials", {
        tokenUrl: "https://id.vendor.example/token",
        clientAuth: "header",
      }),
    ).toContain("clientAuth");
  });
});

describe("validateCredentialFields", () => {
  it("holds the fields to the scheme's table, required and optional", () => {
    expect(validateCredentialFields("api_key_header", { apiKey: "sk" })).toBeNull();
    expect(validateCredentialFields("basic", { username: "u", password: "p" })).toBeNull();
    expect(validateCredentialFields("basic", { username: "u" })).toContain("password");
    expect(validateCredentialFields("bearer", { token: "t", extra: "x" })).toContain("extra");
    expect(
      validateCredentialFields("snowflake_keypair_jwt", {
        privateKey: "pem",
        privateKeyPassphrase: "p",
      }),
    ).toBeNull();
  });

  it("refuses an empty or non-string value without saying what a key looks like", () => {
    expect(validateCredentialFields("bearer", { token: "" })).toContain("token");
    expect(validateCredentialFields("bearer", { token: 42 })).toContain("token");
  });
});

describe("validateOAuthClient", () => {
  it("accepts a client with https endpoints and trims the scopes", () => {
    expect(
      validateOAuthClient({
        clientId: " client ",
        authorizeUrl: "https://accounts.vendor.example/o/authorize",
        tokenUrl: "https://oauth2.vendor.example/token",
        scopes: ["mail.read", " mail.read ", ""],
      }),
    ).toEqual({
      ok: true,
      clientId: "client",
      authorizeUrl: "https://accounts.vendor.example/o/authorize",
      tokenUrl: "https://oauth2.vendor.example/token",
      scopes: ["mail.read"],
    });
  });

  it("refuses an empty client id and a non-https or private endpoint", () => {
    const base = {
      clientId: "c",
      authorizeUrl: "https://a.example.com/x",
      tokenUrl: "https://t.example.com/y",
    };
    expect(validateOAuthClient({ ...base, clientId: " " }).ok).toBe(false);
    expect(validateOAuthClient({ ...base, authorizeUrl: "http://a.example.com/x" }).ok).toBe(false);
    expect(validateOAuthClient({ ...base, tokenUrl: "https://192.168.1.1/y" }).ok).toBe(false);
  });
});
