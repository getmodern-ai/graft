import { describe, expect, it } from "vitest";

import {
  GENERIC_SECRET_FIELD_NAMES,
  REDACTED,
  redactText,
  redactValue,
  secretFieldNamesFor,
} from "./redaction";

/**
 * The one redaction every acquire record passes through (ADR 0012). Each case plants a credential
 * the way a vendor, a proxy or a module actually leaks one, and asserts the value is gone and the
 * surrounding text — including the field's name — is still there to read.
 */

const KEY = "sk_live_the_real_vendor_key_0123456789";
const TOKEN =
  "eyJhbGciOiJFZERTQSIsImtpZCI6ImFiYyJ9.eyJwZXJzb24iOiJwZXJzb25fMSIsImFnZW50IjoiYWdlbnRfYSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";

describe("redactText", () => {
  it("replaces a value the job knows to be secret, wherever it appears, and ignores a short one", () => {
    const result = redactText(`token=${TOKEN}; again ${TOKEN}`, { secretValues: [TOKEN, "ab"] });
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).toBe(`token=${REDACTED}; again ${REDACTED}`);
    expect(result.redacted).toBe(true);
    expect(redactText("ab is not a secret", { secretValues: ["ab"] })).toEqual({
      text: "ab is not a secret",
      redacted: false,
    });
  });

  it("redacts an Authorization header's value, a Bearer or Basic credential, and anything shaped like a JWT", () => {
    const echoed = [
      `authorization: Bearer ${TOKEN}`,
      '"Authorization": "Basic dXNlcjpwYXNzd29yZA=="',
      `the proxy read ${TOKEN} and refused it`,
    ].join("\n");
    const { text } = redactText(echoed);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(text.split("\n")[0]).toBe(`authorization: Bearer ${REDACTED}`);
    expect(text).toContain(`"Authorization": "Basic ${REDACTED}"`);
    expect(text).toContain(`the proxy read ${REDACTED} and refused it`);
  });

  it("redacts the value under a secret field's name in JSON, a header line and a query string, keeping the name", () => {
    const body = `{"error":"unauthorized","apiKey":"${KEY}","x-demo-key": "${KEY}","detail":"x-demo-key=${KEY}&limit=5"}`;
    const { text, redacted } = redactText(body, { secretFieldNames: ["x-demo-key"] });
    expect(redacted).toBe(true);
    expect(text).not.toContain(KEY);
    expect(text).toContain(`"apiKey":"${REDACTED}"`);
    expect(text).toContain(`"x-demo-key": "${REDACTED}"`);
    expect(text).toContain(`x-demo-key=${REDACTED}&limit=5`);
    expect(text).toContain('"error":"unauthorized"');
  });

  it("recognises well-known key shapes in prose, where no field names them", () => {
    const prose = `Invalid API key provided: ${KEY}. Slack said no to xoxb-1234567890-abcdefghij and GitHub to ghp_${"a".repeat(36)}.`;
    const { text } = redactText(prose);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("xoxb-");
    expect(text).not.toContain("ghp_");
    expect(text).toBe(
      `Invalid API key provided: ${REDACTED}. Slack said no to ${REDACTED} and GitHub to ${REDACTED}.`,
    );
    expect(redactText("-----BEGIN PRIVATE KEY-----\nMC4C\n-----END PRIVATE KEY-----").text).toBe(
      REDACTED,
    );
  });

  it("leaves an ordinary body alone and says so", () => {
    const body = '{"items":[{"id":"itm_1","name":"Widget"}],"vendor":"demo","token_count":3}';
    expect(redactText(body)).toEqual({ text: body, redacted: false });
  });
});

describe("redactValue", () => {
  it("walks strings inside a report, keeping keys and shape", () => {
    const report = {
      dryRun: true,
      reads: [{ method: "GET", path: `/items?apiKey=${KEY}`, status: 401 }],
      moduleError: `GET /items 401: {"apiKey":"${KEY}"}`,
      nested: { authorization: `Bearer ${TOKEN}`, count: 2, flag: null },
    };
    const { value, redacted } = redactValue(report, { secretValues: [TOKEN] });
    expect(redacted).toBe(true);
    expect(JSON.stringify(value)).not.toContain(KEY);
    expect(JSON.stringify(value)).not.toContain(TOKEN);
    expect(value).toMatchObject({
      dryRun: true,
      reads: [{ method: "GET", path: `/items?apiKey=${REDACTED}`, status: 401 }],
      nested: { authorization: `Bearer ${REDACTED}`, count: 2, flag: null },
    });
    expect(redactValue({ ok: true, n: 1 })).toEqual({ value: { ok: true, n: 1 }, redacted: false });
  });
});

describe("secretFieldNamesFor", () => {
  it("names the scheme's credential fields and the header or parameter the key rides in", () => {
    expect(secretFieldNamesFor("api_key_header", { headerName: "x-demo-key" })).toEqual([
      "apiKey",
      "x-demo-key",
    ]);
    expect(secretFieldNamesFor("api_key_query", { queryParam: "key" })).toEqual(["apiKey", "key"]);
    expect(secretFieldNamesFor("basic", null)).toEqual(["username", "password"]);
    expect(secretFieldNamesFor("snowflake_keypair_jwt", { account: "a", user: "u" })).toEqual([
      "privateKey",
      "privateKeyPassphrase",
    ]);
  });

  it("the generic names cover what the schemes name, so a scheme added without a rule is still redacted by name", () => {
    for (const name of ["apiKey", "token", "password", "clientSecret", "privateKey"]) {
      expect(GENERIC_SECRET_FIELD_NAMES).toContain(name);
    }
  });
});
