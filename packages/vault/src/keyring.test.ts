import { describe, expect, it } from "vitest";

import {
  canonicalContext,
  createLocalKeyring,
  DATA_KEY_BYTES,
  LOCAL_KEYRING_ID,
  MIN_LOCAL_KEYRING_SECRET_LENGTH,
} from "./keyring";

/**
 * The local backing of the keyring seam (ADR 0002). What the KMS backing will be held to as well:
 * a fresh data key per call, the wrapped form bound to the context, and no way to unwrap under
 * another context or another key.
 */

const SECRET = "test-secret-that-is-long-enough-32";
const CONTEXT = { purpose: "test", personId: "person_1", connectionId: "conn_1" };

describe("createLocalKeyring", () => {
  it("names itself and refuses a secret shorter than the minimum", () => {
    expect(createLocalKeyring(SECRET).id).toBe(LOCAL_KEYRING_ID);
    expect(() => createLocalKeyring("short")).toThrow(
      new RegExp(String(MIN_LOCAL_KEYRING_SECRET_LENGTH)),
    );
  });

  it("generates a fresh 256-bit data key each time, and never leaves it in the wrapped bytes", async () => {
    const keyring = createLocalKeyring(SECRET);
    const a = await keyring.generateDataKey(CONTEXT);
    const b = await keyring.generateDataKey(CONTEXT);

    expect(a.plaintext.byteLength).toBe(DATA_KEY_BYTES);
    expect(Buffer.from(a.plaintext).equals(Buffer.from(b.plaintext))).toBe(false);
    expect(Buffer.from(a.wrapped).equals(Buffer.from(b.wrapped))).toBe(false);
    expect(Buffer.from(a.wrapped).includes(Buffer.from(a.plaintext))).toBe(false);
  });

  it("unwraps under the same context, from another instance over the same secret", async () => {
    const { plaintext, wrapped } = await createLocalKeyring(SECRET).generateDataKey(CONTEXT);

    const back = await createLocalKeyring(SECRET).unwrapDataKey(wrapped, CONTEXT);
    expect(Buffer.from(back).equals(Buffer.from(plaintext))).toBe(true);
  });

  it("refuses to unwrap under another context — the binding a moved ciphertext runs into", async () => {
    const keyring = createLocalKeyring(SECRET);
    const { wrapped } = await keyring.generateDataKey(CONTEXT);

    await expect(
      keyring.unwrapDataKey(wrapped, { ...CONTEXT, connectionId: "conn_2" }),
    ).rejects.toThrow();
  });

  it("refuses to unwrap under another secret, and refuses bytes of the wrong length", async () => {
    const { wrapped } = await createLocalKeyring(SECRET).generateDataKey(CONTEXT);

    await expect(
      createLocalKeyring("another-secret-that-is-long-enough-32").unwrapDataKey(wrapped, CONTEXT),
    ).rejects.toThrow();
    await expect(
      createLocalKeyring(SECRET).unwrapDataKey(new Uint8Array(10), CONTEXT),
    ).rejects.toThrow(/local keyring/);
  });
});

describe("canonicalContext", () => {
  it("serialises the same entries identically whatever their order", () => {
    expect(canonicalContext({ b: "2", a: "1" }).toString()).toBe('{"a":"1","b":"2"}');
    expect(canonicalContext({ a: "1", b: "2" }).equals(canonicalContext({ b: "2", a: "1" }))).toBe(
      true,
    );
  });
});
