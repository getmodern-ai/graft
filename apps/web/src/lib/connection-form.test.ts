import { describe, expect, it } from "vitest";

import {
  credentialFieldsFor,
  draftFromProposal,
  emptyDraft,
  hostsOf,
  parametersFor,
  parseHostList,
  SCHEMES,
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
