import { describe, expect, it } from "vitest";

import { keyringConformance } from "./conformance";
import {
  canonicalContext,
  createLocalKeyring,
  LOCAL_KEYRING_ID,
  MIN_LOCAL_KEYRING_SECRET_LENGTH,
} from "./keyring";

/**
 * The local backing of the keyring seam (ADR 0002) against the one suite every backing runs
 * (`./conformance.ts`), plus what is true of this backing alone: the secret it derives from, and
 * that another secret is another key.
 */

const SECRET = "test-secret-that-is-long-enough-32";
const CONTEXT = { purpose: "test", personId: "person_1", connectionId: "conn_1" };

keyringConformance("local", () => ({ makeKeyring: () => createLocalKeyring(SECRET) }));

describe("createLocalKeyring", () => {
  it("names itself and refuses a secret shorter than the minimum", () => {
    expect(createLocalKeyring(SECRET).id).toBe(LOCAL_KEYRING_ID);
    expect(() => createLocalKeyring("short")).toThrow(
      new RegExp(String(MIN_LOCAL_KEYRING_SECRET_LENGTH)),
    );
  });

  it("refuses to unwrap under another secret, and names itself on bytes of the wrong length", async () => {
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
