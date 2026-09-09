import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATA_KEY_BYTES, type Keyring } from "./keyring";
import { CredentialScopeMismatchError, createCredentialVault } from "./vault";

/**
 * One suite, every backing of the keyring seam. ADR 0002's "exactly two backings per seam" holds
 * only while both answer the same questions, so the questions live here: the local keyring's test
 * file calls `keyringConformance` with itself, and the hosted form's keyring, in the private
 * package, calls it with a fake of its provider always and with the real one on demand. A change to
 * the seam lands here first and fails every backing that has not caught up.
 *
 * What is asserted is what the vault can observe through the seam — a data key of the right size, a
 * wrapped form that opens under its context and under no other, a refusal for bytes that were
 * altered — never how the backing wraps. The last case runs the real vault over the keyring, because
 * the encryption context the vault binds a row to is only a contract if the backing enforces it.
 */

export type KeyringFixture = {
  /**
   * A keyring over the backing's material. Called more than once: two instances over the same
   * material must open each other's wrapped keys, as the process that encrypted a credential and the
   * one that later decrypts it do.
   */
  makeKeyring: () => Promise<Keyring> | Keyring;
  /** Release whatever the fixture holds. */
  close?: () => Promise<void>;
};

export function keyringConformance(
  name: string,
  makeFixture: () => Promise<KeyringFixture> | KeyringFixture,
): void {
  describe(`keyring conformance: ${name}`, () => {
    const CONTEXT = { purpose: "conformance", personId: "person_1", connectionId: "conn_1" };
    let fixture: KeyringFixture;
    let keyring: Keyring;

    beforeAll(async () => {
      fixture = await makeFixture();
      keyring = await fixture.makeKeyring();
    });

    afterAll(async () => {
      await fixture.close?.();
    });

    it("names itself, so an envelope can say which keyring opens it", () => {
      expect(typeof keyring.id).toBe("string");
      expect(keyring.id.length).toBeGreaterThan(0);
    });

    it("generates a fresh 256-bit data key each time, and never leaves it in the wrapped bytes", async () => {
      const a = await keyring.generateDataKey(CONTEXT);
      const b = await keyring.generateDataKey(CONTEXT);

      expect(a.plaintext.byteLength).toBe(DATA_KEY_BYTES);
      expect(b.plaintext.byteLength).toBe(DATA_KEY_BYTES);
      expect(Buffer.from(a.plaintext).equals(Buffer.from(b.plaintext))).toBe(false);
      expect(Buffer.from(a.wrapped).equals(Buffer.from(b.wrapped))).toBe(false);
      expect(Buffer.from(a.wrapped).includes(Buffer.from(a.plaintext))).toBe(false);
    });

    it("unwraps under the same context, from a second instance over the same material", async () => {
      const { plaintext, wrapped } = await keyring.generateDataKey(CONTEXT);
      const other = await fixture.makeKeyring();

      expect(other.id).toBe(keyring.id);
      const back = await other.unwrapDataKey(wrapped, CONTEXT);
      expect(Buffer.from(back).equals(Buffer.from(plaintext))).toBe(true);
    });

    it("refuses to unwrap under another context — the binding a moved ciphertext runs into", async () => {
      const { wrapped } = await keyring.generateDataKey(CONTEXT);

      await expect(
        keyring.unwrapDataKey(wrapped, { ...CONTEXT, connectionId: "conn_2" }),
      ).rejects.toThrow();
      await expect(
        keyring.unwrapDataKey(wrapped, { purpose: CONTEXT.purpose, personId: CONTEXT.personId }),
      ).rejects.toThrow();
    });

    it("refuses wrapped bytes that were altered, and bytes that are not a wrapped key at all", async () => {
      const { wrapped } = await keyring.generateDataKey(CONTEXT);
      const altered = Buffer.from(wrapped);
      altered[altered.byteLength - 1] = (altered[altered.byteLength - 1] ?? 0) ^ 0x01;

      await expect(keyring.unwrapDataKey(altered, CONTEXT)).rejects.toThrow();
      await expect(
        keyring.unwrapDataKey(randomBytes(wrapped.byteLength), CONTEXT),
      ).rejects.toThrow();
      await expect(keyring.unwrapDataKey(new Uint8Array(10), CONTEXT)).rejects.toThrow();
    });

    it("carries a credential through the vault: encrypted here, decrypted by another instance, refused for another row", async () => {
      const vault = createCredentialVault(keyring);
      const scope = { personId: "person_1", connectionId: "conn_1" };
      const fields = { apiKey: "sk_live_conformance_0123456789" };

      const ciphertext = await vault.encrypt(fields, scope);

      expect(ciphertext.includes(Buffer.from(fields.apiKey, "utf8"))).toBe(false);
      expect(await vault.decrypt(ciphertext, scope)).toEqual(fields);
      // The server that decrypts is not the one that encrypted: a second vault over a second instance.
      const later = createCredentialVault(await fixture.makeKeyring());
      expect(await later.decrypt(ciphertext, scope)).toEqual(fields);
      await expect(vault.decrypt(ciphertext, { ...scope, connectionId: "conn_2" })).rejects.toThrow(
        CredentialScopeMismatchError,
      );
    });
  });
}
