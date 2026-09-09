import { describe, expect, it } from "vitest";

import { createLocalKeyring, type Keyring } from "./keyring";
import {
  CredentialCiphertextError,
  CredentialScopeMismatchError,
  CredentialShapeError,
  createCredentialVault,
} from "./vault";

/**
 * The vault over the local keyring — the same `createCredentialVault` the hosted form wraps around
 * KMS, with only the keyring swapped, so nothing here reaches a network and every case below is the
 * real encrypt and decrypt path. Copied from Cando's suite (ADR 0011) and extended for the envelope
 * this package now owns.
 */

const SECRET = "test-secret-that-is-long-enough-32";
const SCOPE = { personId: "person_1", connectionId: "conn_1" };
const FIELDS = { apiKey: "sk_live_very_secret_value_1234567890" };

function vault(secret = SECRET) {
  return createCredentialVault(createLocalKeyring(secret));
}

describe("credential vault", () => {
  it("round-trips a credential record", async () => {
    const v = vault();
    const ciphertext = await v.encrypt(FIELDS, SCOPE);

    expect(await v.decrypt(ciphertext, SCOPE)).toEqual(FIELDS);
  });

  it("stores ciphertext, not the secret — the plaintext never appears in the bytes", async () => {
    const ciphertext = await vault().encrypt(FIELDS, SCOPE);

    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(ciphertext.includes(Buffer.from(FIELDS.apiKey, "utf8"))).toBe(false);
    expect(ciphertext.includes(Buffer.from("apiKey", "utf8"))).toBe(false);
  });

  it("carries the row's ids as authenticated context, readable without the key", async () => {
    const ciphertext = await vault().encrypt(FIELDS, SCOPE);

    // The encryption context is in the envelope's header in the clear — ids are not secret, and
    // that is what lets decrypt check them. The purpose marker and the keyring's name ride beside.
    expect(ciphertext.includes(Buffer.from("person_1", "utf8"))).toBe(true);
    expect(ciphertext.includes(Buffer.from("conn_1", "utf8"))).toBe(true);
    expect(ciphertext.includes(Buffer.from("graft:connection-credential", "utf8"))).toBe(true);
    expect(ciphertext.includes(Buffer.from("local", "utf8"))).toBe(true);
  });

  /**
   * The property the encryption context is for: a ciphertext moved onto another row — by a bug or
   * by a database write — must not hand that row a credential.
   */
  it("refuses to decrypt under another connection id", async () => {
    const v = vault();
    const ciphertext = await v.encrypt(FIELDS, SCOPE);

    await expect(v.decrypt(ciphertext, { ...SCOPE, connectionId: "conn_2" })).rejects.toThrow(
      CredentialScopeMismatchError,
    );
  });

  it("refuses to decrypt under another person id", async () => {
    const v = vault();
    const ciphertext = await v.encrypt(FIELDS, SCOPE);

    await expect(v.decrypt(ciphertext, { ...SCOPE, personId: "person_2" })).rejects.toThrow(
      /personId/,
    );
  });

  it("refuses a ciphertext wrapped under a different key", async () => {
    const ciphertext = await vault("another-secret-that-is-long-enough-32").encrypt(FIELDS, SCOPE);

    await expect(vault().decrypt(ciphertext, SCOPE)).rejects.toThrow();
  });

  it("refuses a tampered ciphertext, wherever the byte was flipped", async () => {
    const v = vault();
    const ciphertext = await v.encrypt(FIELDS, SCOPE);
    // The body near its end, the wrapped data key, and the header's version byte.
    for (const at of [ciphertext.length - 4, 8 + "local".length + 2 + 60, 0]) {
      const tampered = Buffer.from(ciphertext);
      tampered[at] = (tampered[at] ?? 0) ^ 0xff;

      await expect(v.decrypt(tampered, SCOPE), `byte ${at}`).rejects.toThrow();
    }
  });

  /**
   * A header rewritten to name this row, over a body encrypted for another: the context compares
   * equal, and the tag then refuses it — the comparison is a shortcut, not the guarantee.
   */
  it("refuses a ciphertext whose header was rewritten to match the row", async () => {
    const v = vault();
    const forOther = await v.encrypt(FIELDS, { ...SCOPE, connectionId: "conn_2" });
    const rewritten = Buffer.from(
      forOther.toString("latin1").replace('"connectionId":"conn_2"', '"connectionId":"conn_1"'),
      "latin1",
    );

    await expect(v.decrypt(rewritten, SCOPE)).rejects.toThrow();
    await expect(v.decrypt(rewritten, SCOPE)).rejects.not.toThrow(CredentialScopeMismatchError);
  });

  it("refuses bytes that are not a ciphertext at all, by name", async () => {
    await expect(vault().decrypt(Buffer.from("not a ciphertext"), SCOPE)).rejects.toThrow(
      CredentialCiphertextError,
    );
    await expect(vault().decrypt(Buffer.from([1, 0]), SCOPE)).rejects.toThrow(
      CredentialCiphertextError,
    );
    await expect(vault().decrypt(Buffer.alloc(0), SCOPE)).rejects.toThrow(
      CredentialCiphertextError,
    );
  });

  it("refuses a ciphertext another keyring wrapped, naming both", async () => {
    const other: Keyring = { ...createLocalKeyring(SECRET), id: "kms" };
    const ciphertext = await createCredentialVault(other).encrypt(FIELDS, SCOPE);

    await expect(vault().decrypt(ciphertext, SCOPE)).rejects.toThrow(
      /wrapped by the kms keyring, not local/,
    );
  });

  it("refuses an oversized ciphertext before trying to decrypt it", async () => {
    await expect(vault().decrypt(Buffer.alloc(65 * 1024), SCOPE)).rejects.toThrow(/exceeds/);
  });

  it("refuses an absurd credential record before asking for a data key", async () => {
    let asked = 0;
    const counting: Keyring = {
      ...createLocalKeyring(SECRET),
      generateDataKey: async (context) => {
        asked += 1;
        return createLocalKeyring(SECRET).generateDataKey(context);
      },
    };
    await expect(
      createCredentialVault(counting).encrypt({ apiKey: "x".repeat(20_000) }, SCOPE),
    ).rejects.toThrow(/exceeds/);
    expect(asked).toBe(0);
  });

  /**
   * The local keyring is what a server encrypts with and, later, what its proxy decrypts with —
   * two processes, one secret — so the derivation has to be a function of the secret alone.
   */
  it("derives the same local key from the same secret across vault instances", async () => {
    const ciphertext = await vault().encrypt(FIELDS, SCOPE);

    expect(await vault().decrypt(ciphertext, SCOPE)).toEqual(FIELDS);
  });

  it("keeps every field of a multi-field credential", async () => {
    const v = vault();
    const fields = { username: "acme", password: "p@ss word with spaces and ünïcode" };

    expect(await v.decrypt(await v.encrypt(fields, SCOPE), SCOPE)).toEqual(fields);
  });

  /**
   * What the data-key cache is for: the proxy decrypts one row's ciphertext on every vendor call,
   * and only the first of those should reach the keyring — in the hosted form, KMS.
   */
  it("decrypts the same row repeatedly — the proxy's hot path — unwrapping the data key once", async () => {
    let unwraps = 0;
    const local = createLocalKeyring(SECRET);
    const counting: Keyring = {
      ...local,
      unwrapDataKey: (wrapped, context) => {
        unwraps += 1;
        return local.unwrapDataKey(wrapped, context);
      },
    };
    const v = createCredentialVault(counting);
    const ciphertext = await v.encrypt(FIELDS, SCOPE);

    await v.decrypt(ciphertext, SCOPE);
    await v.decrypt(ciphertext, SCOPE);
    await v.decrypt(ciphertext, SCOPE);

    expect(unwraps).toBe(1);
  });

  it("asks the keyring again once the cached data key has aged out", async () => {
    let unwraps = 0;
    let clock = 1_000_000;
    const local = createLocalKeyring(SECRET);
    const counting: Keyring = {
      ...local,
      unwrapDataKey: (wrapped, context) => {
        unwraps += 1;
        return local.unwrapDataKey(wrapped, context);
      },
    };
    const v = createCredentialVault(counting, { now: () => clock });
    const ciphertext = await v.encrypt(FIELDS, SCOPE);

    await v.decrypt(ciphertext, SCOPE);
    clock += 5 * 60 * 1000 - 1;
    await v.decrypt(ciphertext, SCOPE);
    expect(unwraps).toBe(1);
    clock += 1;
    await v.decrypt(ciphertext, SCOPE);
    expect(unwraps).toBe(2);
  });

  it("names a decrypted payload that is not a record of strings", () => {
    expect(new CredentialShapeError().name).toBe("CredentialShapeError");
  });
});
