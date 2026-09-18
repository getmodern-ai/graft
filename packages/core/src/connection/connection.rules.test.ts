import { describe, expect, it } from "vitest";

import {
  SIGN_IN_HOSTS,
  setAsideSignInHosts,
  takesCredential,
  validateCredentialFields,
  validateHostSet,
  validateIssuedCredentialFields,
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
      if (!asPrimary.ok) {
        expect(asPrimary.problem).toContain("not a public host");
        // The reason word the API, the meta-tool and the form show (GRA-28), and the host as the
        // URL parser spells it, so the form can mark the input it came from.
        expect(asPrimary.reason).toBe("host_not_public");
        expect(asPrimary.host).toBe(host);
      }
    }
    const asExtra = validateHostSet("https://api.vendor.example", ["169.254.169.254"]);
    expect(asExtra).toMatchObject({
      ok: false,
      reason: "host_not_public",
      host: "169.254.169.254",
    });
  });

  it("says invalid, not host_not_public, for a refusal about shape", () => {
    expect(validateHostSet("http://api.vendor.example", [])).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(validateHostSet("https://api.vendor.example", ["not a host"])).toMatchObject({
      ok: false,
      reason: "invalid",
      host: "not a host",
    });
  });

  it("refuses an additional host that is not a hostname", () => {
    for (const bad of ["https://files.vendor.example", "files.vendor.example/path", "files"]) {
      const verdict = validateHostSet("https://api.vendor.example", [bad]);
      expect(verdict.ok, bad).toBe(false);
    }
  });
});

/** GRA-89: sign-in endpoints are not hosts. Over `validateHostSet`'s output, as the meta-tool applies it. */
describe("setAsideSignInHosts", () => {
  const GOOGLE = {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/gmail.readonly",
  };

  it("sets aside the endpoints' hosts and the scheme's well-known ones, in the order proposed, and keeps the rest", () => {
    expect(
      setAsideSignInHosts("oauth_authorization_code", GOOGLE, "https://gmail.googleapis.com", [
        "gmail.googleapis.com",
        "oauth2.googleapis.com",
        "accounts.google.com",
        "www.googleapis.com",
      ]),
    ).toEqual({
      ok: true,
      hosts: ["gmail.googleapis.com", "www.googleapis.com"],
      setAside: ["oauth2.googleapis.com", "accounts.google.com"],
    });
    // A port is the host's, not the hostname's.
    expect(
      setAsideSignInHosts("oauth_authorization_code", GOOGLE, "https://gmail.googleapis.com", [
        "gmail.googleapis.com",
        "accounts.google.com:443",
      ]),
    ).toEqual({ ok: true, hosts: ["gmail.googleapis.com"], setAside: ["accounts.google.com:443"] });
    expect(SIGN_IN_HOSTS.oauth_authorization_code).toEqual([
      "accounts.google.com",
      "oauth2.googleapis.com",
    ]);
  });

  it("the well-known hosts belong to the scheme whose flow uses them, and the endpoint hosts to any scheme that carries them", () => {
    // A bearer proposal listing Google's sign-in host is not judged: the rule does not guess.
    expect(
      setAsideSignInHosts("bearer", {}, "https://gmail.googleapis.com", [
        "gmail.googleapis.com",
        "accounts.google.com",
      ]),
    ).toEqual({
      ok: true,
      hosts: ["gmail.googleapis.com", "accounts.google.com"],
      setAside: [],
    });
    // Client credentials carry a token URL, and its host is set aside like the code flow's.
    expect(
      setAsideSignInHosts(
        "oauth2_client_credentials",
        { tokenUrl: "https://identity.xero.example/connect/token" },
        "https://api.xero.example",
        ["api.xero.example", "identity.xero.example"],
      ),
    ).toEqual({ ok: true, hosts: ["api.xero.example"], setAside: ["identity.xero.example"] });
  });

  it("never sets aside the primary's hostname, which some vendors share with the token endpoint", () => {
    // Notion, Slack, HubSpot and Dropbox serve the token endpoint on the API host itself.
    expect(
      setAsideSignInHosts(
        "oauth_authorization_code",
        {
          authorizeUrl: "https://api.notion.example/v1/oauth/authorize",
          tokenUrl: "https://api.notion.example/v1/oauth/token",
        },
        "https://api.notion.example/v1",
        ["api.notion.example"],
      ),
    ).toEqual({ ok: true, hosts: ["api.notion.example"], setAside: [] });
  });

  it("refuses a primary on a well-known sign-in host, or one that is the endpoint URL itself, saying why", () => {
    const wellKnown = setAsideSignInHosts(
      "oauth_authorization_code",
      GOOGLE,
      "https://accounts.google.com/o/oauth2/v2/auth",
      ["accounts.google.com", "gmail.googleapis.com"],
    );
    expect(wellKnown).toMatchObject({
      ok: false,
      host: "accounts.google.com",
      problem: expect.stringContaining("sign-in host, not an API host"),
    });
    expect((wellKnown as { problem: string }).problem).toContain("gmail.googleapis.com");

    const endpoint = setAsideSignInHosts(
      "oauth2_client_credentials",
      { tokenUrl: "https://login.vendor.example/oauth/token" },
      "https://login.vendor.example/oauth/token",
      ["login.vendor.example"],
    );
    expect(endpoint).toMatchObject({
      ok: false,
      host: "login.vendor.example",
      problem: expect.stringContaining("is the tokenUrl endpoint itself"),
    });
    // The same host with a different path is an API host, and the token host is then the primary's.
    expect(
      setAsideSignInHosts(
        "oauth2_client_credentials",
        { tokenUrl: "https://login.vendor.example/oauth/token" },
        "https://login.vendor.example/api",
        ["login.vendor.example"],
      ),
    ).toEqual({ ok: true, hosts: ["login.vendor.example"], setAside: [] });
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

  it("none takes an empty credential and nothing else, and is the one signing scheme that takes no credential", () => {
    expect(validateCredentialFields("none", {})).toBeNull();
    expect(validateCredentialFields("none", { apiKey: "made-up" })).toBe(
      "The none scheme sends no credential and takes no fields — not apiKey",
    );
    expect(takesCredential("none")).toBe(false);
    expect(takesCredential("gateway")).toBe(false);
    for (const scheme of ["api_key_header", "bearer", "basic", "snowflake_keypair_jwt"] as const) {
      expect(takesCredential(scheme), scheme).toBe(true);
    }
  });

  it("refuses an empty or non-string value without saying what a key looks like", () => {
    expect(validateCredentialFields("bearer", { token: "" })).toContain("token");
    expect(validateCredentialFields("bearer", { token: 42 })).toContain("token");
  });
});

/**
 * The authorization-code scheme's parameters (ADR 0005): the two endpoints and the scopes the agent
 * proposes from the documentation, and the client id only the person can supply — absent from a
 * proposal, required at registration, one rule with two stages.
 */
describe("validateSchemeConfig for oauth_authorization_code", () => {
  const proposed = {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/gmail.readonly",
  };

  it("lets a proposal omit the client id and requires it of a registration", () => {
    expect(
      validateSchemeConfig("oauth_authorization_code", proposed, { proposal: true }),
    ).toBeNull();
    expect(validateSchemeConfig("oauth_authorization_code", proposed)).toContain("clientId");
    expect(
      validateSchemeConfig("oauth_authorization_code", { ...proposed, clientId: "client-id" }),
    ).toBeNull();
    expect(
      validateSchemeConfig("oauth_authorization_code", {
        ...proposed,
        clientId: "client-id",
        clientAuth: "basic",
      }),
    ).toBeNull();
  });

  it("holds both endpoints to https on a public host, clientAuth to its two values, and refuses unknown parameters", () => {
    const registered = { ...proposed, clientId: "client-id" };
    expect(
      validateSchemeConfig("oauth_authorization_code", {
        ...registered,
        authorizeUrl: "http://accounts.google.com/o/oauth2/v2/auth",
      }),
    ).toContain("authorize URL must use https");
    expect(
      validateSchemeConfig("oauth_authorization_code", {
        ...registered,
        tokenUrl: "https://10.0.0.1/token",
      }),
    ).toContain("not a public host");
    expect(
      validateSchemeConfig("oauth_authorization_code", { ...registered, clientAuth: "header" }),
    ).toContain("clientAuth");
    expect(
      validateSchemeConfig("oauth_authorization_code", { ...registered, clientSecret: "s" }),
    ).toContain("takes no clientSecret");
  });

  it("does not let a proposal omit a parameter the agent is meant to propose", () => {
    expect(
      validateSchemeConfig(
        "oauth_authorization_code",
        { tokenUrl: proposed.tokenUrl },
        { proposal: true },
      ),
    ).toContain("authorizeUrl");
  });
});

describe("validateIssuedCredentialFields", () => {
  const record = {
    clientSecret: "s",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: "2026-09-09T11:00:00.000Z",
  };

  it("accepts the client secret beside the issued fields, with the refresh token and expiry optional", () => {
    expect(validateIssuedCredentialFields("oauth_authorization_code", record)).toBeNull();
    expect(
      validateIssuedCredentialFields("oauth_authorization_code", {
        clientSecret: "s",
        accessToken: "a",
      }),
    ).toBeNull();
  });

  it("needs the access token and the client secret, refuses a field from neither table, and a scheme that issues nothing", () => {
    expect(
      validateIssuedCredentialFields("oauth_authorization_code", { clientSecret: "s" }),
    ).toContain("accessToken");
    expect(
      validateIssuedCredentialFields("oauth_authorization_code", { accessToken: "a" }),
    ).toContain("clientSecret");
    expect(
      validateIssuedCredentialFields("oauth_authorization_code", { ...record, idToken: "x" }),
    ).toContain("takes no idToken");
    expect(
      validateIssuedCredentialFields("oauth_authorization_code", { ...record, accessToken: "" }),
    ).toContain("accessToken");
    expect(validateIssuedCredentialFields("bearer", { token: "t" })).toContain("issues no");
  });

  it("the entry rule still refuses what only a consent may write", () => {
    expect(
      validateCredentialFields("oauth_authorization_code", { clientSecret: "s", accessToken: "a" }),
    ).toContain("takes no accessToken");
    expect(validateCredentialFields("oauth_authorization_code", { clientSecret: "s" })).toBeNull();
  });
});
