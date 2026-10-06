import { describe, expect, it } from "vitest";

import {
  credentialFieldsFor,
  draftFromProposal,
  emptyDraft,
  googleNoticeFor,
  hostsNoticeTitle,
  hostsOf,
  isOAuthDraft,
  parametersFor,
  parseHostList,
  SCHEMES,
  secretLegend,
  validateConnectionDraft,
  validateCredentialDraft,
  withScheme,
} from "./connection-form";

/**
 * The form's rules are the service's (GRA-28): what is asserted here is that each refusal lands
 * under the input it is about, and that every scheme's inputs come from the proxy's tables.
 */

const draft = {
  ...emptyDraft("api_key_header"),
  vendor: "acme",
  displayName: "Acme Orders",
  schemeConfig: { headerName: "x-acme-key", prefix: "" },
  primaryHost: "https://API.acme.example/v2/",
  hosts: "files.acme.example, Cdn.acme.example\n",
  credential: { apiKey: "sk_live_1" },
};

describe("the scheme tables reach the form", () => {
  it("renders every scheme's secret fields and parameters from the tables, required first", () => {
    expect(credentialFieldsFor("none")).toEqual([]);
    expect(credentialFieldsFor("basic").map((f) => [f.name, f.required])).toEqual([
      ["username", true],
      ["password", true],
    ]);
    expect(credentialFieldsFor("oauth2_client_credentials").map((f) => f.name)).toEqual([
      "clientId",
      "clientSecret",
    ]);
    expect(credentialFieldsFor("snowflake_keypair_jwt").map((f) => [f.name, f.required])).toEqual([
      ["privateKey", true],
      ["privateKeyPassphrase", false],
    ]);
    expect(parametersFor("api_key_header").map((f) => [f.name, f.required])).toEqual([
      ["headerName", true],
      ["prefix", false],
    ]);
    for (const scheme of SCHEMES) {
      // `none` is the one scheme with no secret input; the form says so in its place (GRA-66).
      if (scheme === "none") continue;
      expect(credentialFieldsFor(scheme).length, scheme).toBeGreaterThan(0);
    }
  });

  it("switching scheme blanks the parameters and the secret fields for the new one", () => {
    const next = withScheme(draft, "basic");
    expect(next.schemeConfig).toEqual({});
    expect(next.credential).toEqual({ username: "", password: "" });
    expect(next.vendor).toBe("acme");
  });
});

describe("validateConnectionDraft", () => {
  it("normalises a passing draft as the service will store it", () => {
    expect(validateConnectionDraft(draft)).toEqual({
      ok: true,
      value: {
        vendor: "acme",
        displayName: "Acme Orders",
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-acme-key" },
        primaryHost: "https://api.acme.example/v2",
        hosts: ["api.acme.example", "files.acme.example", "cdn.acme.example"],
        credential: { apiKey: "sk_live_1" },
      },
    });
  });

  it("puts a private or metadata host's refusal under the input it came from, with the reason", () => {
    const primary = validateConnectionDraft({ ...draft, primaryHost: "https://10.0.0.5" });
    expect(primary).toMatchObject({
      ok: false,
      errors: { primaryHost: expect.stringContaining("not a public host") },
    });
    const additional = validateConnectionDraft({ ...draft, hosts: "169.254.169.254" });
    expect(additional).toMatchObject({
      ok: false,
      errors: { hosts: expect.stringContaining("169.254.169.254 is not a public host") },
    });
    if (!additional.ok) expect(additional.errors.primaryHost).toBeUndefined();
  });

  it("lands each rule under its own input, all at once", () => {
    const verdict = validateConnectionDraft({
      ...draft,
      vendor: "Acme",
      displayName: "",
      schemeConfig: { headerName: "", prefix: "" },
      primaryHost: "http://api.acme.example",
      credential: { apiKey: "" },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(Object.keys(verdict.errors).sort()).toEqual([
      "credential.apiKey",
      "displayName",
      "primaryHost",
      "schemeConfig.headerName",
      "vendor",
    ]);
    // The rule is core's, shared with a model's refusal; the field says integration (GRA-216).
    expect(verdict.errors.vendor).toMatch(/^An integration's slug is lowercase letters/);
  });

  it("can judge the non-secret half alone", () => {
    const verdict = validateConnectionDraft(
      { ...draft, credential: { apiKey: "" } },
      { withCredential: false },
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("validateCredentialDraft", () => {
  it("holds the fields to the scheme's table and names the missing one", () => {
    expect(validateCredentialDraft("basic", { username: "u", password: "p" })).toEqual({
      ok: true,
      value: { username: "u", password: "p" },
    });
    expect(validateCredentialDraft("basic", { username: "u", password: "" })).toMatchObject({
      ok: false,
      errors: { "credential.password": expect.stringContaining("password") },
    });
  });
});

describe("hosts and proposals", () => {
  it("parses one host per line or comma, and previews the set the credential will reach", () => {
    expect(parseHostList(" a.example\n, b.example ,\n")).toEqual(["a.example", "b.example"]);
    expect(hostsOf(draft)).toEqual(["api.acme.example", "files.acme.example", "cdn.acme.example"]);
    expect(hostsOf({ ...draft, primaryHost: "nope" })).toBeNull();
  });

  it("titles the hosts notice and the secret legend after the scheme: no credential, no secret named (GRA-91)", () => {
    expect(hostsNoticeTitle(draft)).toBe(
      "The credential will be sent to these hosts and to nothing else",
    );
    expect(hostsNoticeTitle({ ...draft, primaryHost: "nope" })).toBe(
      "Fix the hosts above to see where the credential will be sent",
    );
    expect(secretLegend(draft)).toBe("The secret");
    expect(secretLegend(withScheme(draft, "oauth_authorization_code"))).toBe("The client secret");

    const keyless = withScheme(draft, "none");
    expect(hostsNoticeTitle(keyless)).toBe(
      "The integration is reached at these hosts and nothing else",
    );
    expect(hostsNoticeTitle({ ...keyless, primaryHost: "nope" })).toBe(
      "Fix the hosts above to see where the integration is reached",
    );
    expect(secretLegend(keyless)).toBeNull();
    for (const scheme of SCHEMES) {
      const title = hostsNoticeTitle(withScheme(draft, scheme));
      if (scheme === "none") expect(title).not.toMatch(/credential|secret/);
      else expect(title).toContain("credential");
    }
  });

  it("pre-fills a draft from an agent's proposal, the primary's hostname taken out of the additional list", () => {
    const pre = draftFromProposal({
      vendor: "acme",
      displayName: "Acme Orders",
      scheme: "api_key_header",
      schemeConfig: { headerName: "x-acme-key" },
      primaryHost: "https://api.acme.example/v2",
      hosts: ["api.acme.example", "files.acme.example"],
    });
    expect(pre).toEqual({
      vendor: "acme",
      displayName: "Acme Orders",
      scheme: "api_key_header",
      schemeConfig: { headerName: "x-acme-key", prefix: "" },
      primaryHost: "https://api.acme.example/v2",
      hosts: "files.acme.example",
      credential: { apiKey: "" },
    });
  });
});

/**
 * The OAuth consent on the form (ADR 0005): the client id is an input the person fills, the client
 * secret is the one secret, the issued tokens are never inputs, and the Google notice appears for
 * Google hosts and nowhere else.
 */
describe("the OAuth consent's form", () => {
  const gmail = {
    ...emptyDraft("oauth_authorization_code"),
    vendor: "gmail",
    displayName: "Gmail",
    primaryHost: "https://gmail.googleapis.com",
    schemeConfig: {
      clientId: "client-id",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      clientAuth: "",
    },
    credential: { clientSecret: "s" },
  };

  it("renders the client id as a required parameter and the client secret as the one secret, and never the tokens", () => {
    expect(parametersFor("oauth_authorization_code").map((f) => [f.name, f.required])).toEqual([
      ["authorizeUrl", true],
      ["tokenUrl", true],
      ["clientId", true],
      ["scopes", false],
      ["clientAuth", false],
    ]);
    expect(credentialFieldsFor("oauth_authorization_code").map((f) => f.name)).toEqual([
      "clientSecret",
    ]);
    expect(isOAuthDraft(gmail)).toBe(true);
    expect(isOAuthDraft(emptyDraft("bearer"))).toBe(false);
  });

  it("requires the client id at submit, though a proposal arrives without it", () => {
    const proposed = draftFromProposal({
      vendor: "gmail",
      displayName: "Gmail",
      scheme: "oauth_authorization_code",
      schemeConfig: {
        authorizeUrl: gmail.schemeConfig.authorizeUrl,
        tokenUrl: gmail.schemeConfig.tokenUrl,
        scopes: gmail.schemeConfig.scopes,
      },
      primaryHost: "https://gmail.googleapis.com",
      hosts: ["gmail.googleapis.com"],
    });
    expect(proposed.schemeConfig.clientId).toBe("");
    const blank = validateConnectionDraft({ ...proposed, credential: { clientSecret: "s" } });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors["schemeConfig.clientId"]).toContain("clientId");
    const filled = validateConnectionDraft({
      ...proposed,
      schemeConfig: { ...proposed.schemeConfig, clientId: "client-id" },
      credential: { clientSecret: "s" },
    });
    expect(filled.ok).toBe(true);
    if (filled.ok) {
      expect(filled.value.schemeConfig).toEqual({
        authorizeUrl: gmail.schemeConfig.authorizeUrl,
        tokenUrl: gmail.schemeConfig.tokenUrl,
        scopes: gmail.schemeConfig.scopes,
        clientId: "client-id",
      });
      expect(filled.value.credential).toEqual({ clientSecret: "s" });
    }
  });

  it("shows the Google notice for a Google host or authorize endpoint, and for no other", () => {
    expect(googleNoticeFor(gmail)).toContain("seven days");
    expect(
      googleNoticeFor({
        ...gmail,
        primaryHost: "https://api.vendor.example",
        schemeConfig: {
          ...gmail.schemeConfig,
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        },
      }),
    ).toContain("seven days");
    expect(
      googleNoticeFor({
        ...gmail,
        primaryHost: "https://api.vendor.example",
        schemeConfig: {
          ...gmail.schemeConfig,
          authorizeUrl: "https://auth.vendor.example/authorize",
        },
      }),
    ).toBeNull();
    // A key-shaped connection to a Google host has no consent and no notice.
    expect(
      googleNoticeFor({ ...emptyDraft("bearer"), primaryHost: "https://www.googleapis.com" }),
    ).toBeNull();
    // Read from the hosts as typed, before they pass.
    expect(
      googleNoticeFor({ ...gmail, primaryHost: "https://", hosts: "gmail.googleapis.com" }),
    ).toContain("seven days");
  });
});
