import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * The keyring seam (ADR 0002: one core, two backings per seam). A keyring wraps and unwraps the
 * per-record data key the vault encrypts with; it never sees a credential. The self-hosted form
 * runs the local keyring below — AES-256-GCM under a key derived from `GRAFT_KEYRING_SECRET`; the
 * hosted form runs a KMS keyring from the private package (GRA-20), whose two verbs are KMS's own
 * `GenerateDataKey` and `Decrypt`. Both bind the data key to the record's encryption context, so a
 * wrapped key moved to another record cannot be unwrapped under that record's name.
 *
 * The seam is a plain interface of ours rather than the AWS Encryption SDK's `KeyringNode`,
 * deliberately (ADR 0011: copied code is re-read, not trusted). Cando's vault runs on that SDK,
 * whose one npm package bundles the KMS keyring and, with it, the KMS client — a backing present by
 * dependency rather than absent, which ADR 0002 rules out for the open repository. The envelope
 * format is therefore this package's (`vault.ts`), and a change to this interface lands in both
 * backings in the same PR.
 */

/** Non-secret facts a ciphertext is bound to — the record's ids and a purpose marker. */
export type EncryptionContext = Readonly<Record<string, string>>;

export type DataKey = {
  /** The key the vault encrypts one record with; used once and never stored. */
  plaintext: Uint8Array;
  /** The same key as only this keyring can open it; stored beside the ciphertext. */
  wrapped: Uint8Array;
};

export type Keyring = {
  /** Names the backing in the envelope, so a ciphertext says which keyring can open it. */
  readonly id: string;
  /** A fresh 256-bit data key and its wrapped form, bound to `context`. */
  generateDataKey(context: EncryptionContext): Promise<DataKey>;
  /**
   * The data key back. Throws when the wrapped bytes are not this keyring's, were tampered with,
   * or were wrapped under a different context — never a plaintext under the wrong name.
   */
  unwrapDataKey(wrapped: Uint8Array, context: EncryptionContext): Promise<Uint8Array>;
};

/** AES-256 — what the vault's body cipher and both backings agree on. */
export const DATA_KEY_BYTES = 32;

/**
 * The context as bytes both sides derive identically: JSON with the keys sorted, so two contexts
 * that say the same thing in a different order are the same additional authenticated data.
 */
export function canonicalContext(context: EncryptionContext): Buffer {
  const sorted = Object.fromEntries(
    Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return Buffer.from(JSON.stringify(sorted), "utf8");
}

export const LOCAL_KEYRING_ID = "local";

/** Also what `@graft/env` requires of `GRAFT_KEYRING_SECRET`; checked here too, at the seam. */
export const MIN_LOCAL_KEYRING_SECRET_LENGTH = 32;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The self-hosted keyring: AES-256-GCM under a key derived from a secret the deployment holds.
 * Deterministic on purpose — two processes on one machine, or the server across a restart, derive
 * the same key from the same secret — and namespaced by the derivation string so a key derived for
 * anything else from the same secret is a different key. The derivation is a plain hash because the
 * input is already a 32-plus-character random secret, not a password.
 */
export function createLocalKeyring(secret: string): Keyring {
  if (secret.length < MIN_LOCAL_KEYRING_SECRET_LENGTH) {
    throw new Error(
      `the local keyring secret must be at least ${MIN_LOCAL_KEYRING_SECRET_LENGTH} characters`,
    );
  }
  const masterKey = createHash("sha256").update(`graft:keyring:local:${secret}`).digest();

  return {
    id: LOCAL_KEYRING_ID,
    async generateDataKey(context) {
      const plaintext = randomBytes(DATA_KEY_BYTES);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
      cipher.setAAD(canonicalContext(context));
      const wrapped = Buffer.concat([
        iv,
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return { plaintext, wrapped };
    },
    async unwrapDataKey(wrapped, context) {
      if (wrapped.byteLength !== IV_BYTES + DATA_KEY_BYTES + TAG_BYTES) {
        throw new Error("the wrapped data key is not one the local keyring produced");
      }
      const bytes = Buffer.from(wrapped);
      const iv = bytes.subarray(0, IV_BYTES);
      const body = bytes.subarray(IV_BYTES, IV_BYTES + DATA_KEY_BYTES);
      const tag = bytes.subarray(IV_BYTES + DATA_KEY_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
      decipher.setAAD(canonicalContext(context));
      decipher.setAuthTag(tag);
      // `final` throws on a tag mismatch — another key, another context, or tampered bytes.
      return Buffer.concat([decipher.update(body), decipher.final()]);
    },
  };
}
