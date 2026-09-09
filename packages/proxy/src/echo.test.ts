import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_REDACTED,
  echoableSecrets,
  isTextLike,
  redactBodyEchoes,
  redactHeaderEchoes,
} from "./echo";

/**
 * The value-based redaction's own rules, apart from the HTTP boundary `app.test.ts` drives:
 * which values count, which bodies are text, and that a body the rule does not touch is the same
 * bytes — not a re-encoded copy.
 */

const KEY = "sk_demo_secret_value";

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
};

describe("echoableSecrets", () => {
  it("takes every stored and derived value long enough to be a key, once, plus basic auth's base64 pair", () => {
    const secrets = echoableSecrets(
      { username: "ops@example.com", password: "p4ssw0rd-long", short: "abc" },
      { accessToken: "derived-access-token", password: "p4ssw0rd-long" },
    );
    expect(secrets).toEqual([
      "ops@example.com",
      "p4ssw0rd-long",
      "derived-access-token",
      Buffer.from("ops@example.com:p4ssw0rd-long").toString("base64"),
    ]);
  });
});

describe("isTextLike", () => {
  it("reads JSON, text, XML, HTML, forms and structured suffixes as text, and everything else as binary", () => {
    for (const type of [
      "application/json",
      "application/json; charset=utf-8",
      "text/plain",
      "text/html",
      "application/xml",
      "application/problem+json",
      "application/vnd.api+json",
      "image/svg+xml",
      "application/x-www-form-urlencoded",
    ]) {
      expect(isTextLike(type, bytesOf("x")), type).toBe(true);
    }
    for (const type of [
      "application/octet-stream",
      "image/png",
      "application/pdf",
      "application/zip",
    ]) {
      expect(isTextLike(type, bytesOf("x")), type).toBe(false);
    }
  });

  it("decides an untyped body by whether it decodes as UTF-8", () => {
    expect(isTextLike(null, bytesOf("plain words"))).toBe(true);
    expect(isTextLike(null, new Uint8Array([0xff, 0xfe, 0x00, 0x01]))).toBe(false);
    expect(isTextLike(null, new Uint8Array(0))).toBe(false);
  });
});

describe("redactBodyEchoes", () => {
  it("replaces every occurrence in a text-like body and re-derives the bytes", () => {
    const { bytes, changed } = redactBodyEchoes(
      bytesOf(`{"k":"${KEY}","again":"${KEY}"}`),
      "application/json",
      [KEY],
    );
    expect(changed).toBe(true);
    expect(new TextDecoder().decode(bytes)).toBe(
      `{"k":"${CREDENTIAL_REDACTED}","again":"${CREDENTIAL_REDACTED}"}`,
    );
  });

  it("hands the same bytes back for a binary body, a clean body, or no secrets", () => {
    const binary = new Uint8Array(new ArrayBuffer(4));
    binary.set([0x89, 0x50, 0x4e, 0x47]);
    expect(redactBodyEchoes(binary, "image/png", [KEY]).bytes).toBe(binary);
    const clean = bytesOf('{"ok":true}');
    expect(redactBodyEchoes(clean, "application/json", [KEY])).toEqual({
      bytes: clean,
      changed: false,
    });
    const echo = bytesOf(KEY);
    expect(redactBodyEchoes(echo, "text/plain", []).bytes).toBe(echo);
  });
});

describe("redactHeaderEchoes", () => {
  it("rewrites the headers that carry a value, every set-cookie among them, and reports whether any did", () => {
    const headers = new Headers({ "x-echo": `Token ${KEY}`, "x-other": "keep" });
    headers.append("set-cookie", `session=${KEY}; Path=/`);
    headers.append("set-cookie", "theme=dark");
    expect(redactHeaderEchoes(headers, [KEY])).toBe(true);
    expect(headers.get("x-echo")).toBe(`Token ${CREDENTIAL_REDACTED}`);
    expect(headers.get("x-other")).toBe("keep");
    expect(headers.getSetCookie()).toEqual([
      `session=${CREDENTIAL_REDACTED}; Path=/`,
      "theme=dark",
    ]);
    expect(redactHeaderEchoes(new Headers({ "x-other": "keep" }), [KEY])).toBe(false);
  });
});
