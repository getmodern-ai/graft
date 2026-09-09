import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { CredentialFields, CredentialScope } from "@graft/proxy/types";

import { canonicalContext, DATA_KEY_BYTES, type EncryptionContext, type Keyring } from "./keyring";

/**
 * The vault: envelope encryption for the credentials Graft holds — a connection's API key, entered
 * by the person in the console (ADR 0006) and stored on the connection row. GRA-1 ("The core and
 * its seams") has the shape — every credential encrypted under a key we control and decrypted in
 * exactly one component — and this file is the two operations that decision needs, and what they
 * guarantee here:
 *
 * - **Encrypt is the connection service's; decrypt is the proxy's, nobody else's.** The connection
 *   seam takes `EncryptOnlyVault` (below), so a `decrypt` from anywhere on a request path does not
 *   compile; `apps/server` binds the whole vault to the proxy, and that binding is the one place a
 *   stored credential becomes plaintext. Anything that wants to *show* one is asking for what
 *   "credentials are write-only after entry" (CONTEXT.md, *Connection*) exists to refuse.
 * - **A ciphertext is bound to its row.** The person and connection ids are the encryption context,
 *   authenticated on both layers of the envelope, and `decrypt` refuses a header carrying any other,
 *   so a ciphertext copied onto a different row yields `CredentialScopeMismatchError`, never a
 *   credential under that row's name. The unwrapped data key is cached for `CACHE_MAX_AGE_MS`, so
 *   the proxy's repeated decrypt of one row asks the keyring — in the hosted form, KMS — once.
 *
 * Copied from Cando (ADR 0011), where it ran on the AWS Encryption SDK; the SDK went with the
 * broker, for the reason `keyring.ts` gives, and the envelope here is the same idea in `node:crypto`:
 * a fresh AES-256-GCM data key per record, wrapped by the keyring, the record encrypted under it,
 * and the context bound to both. The vocabulary is the proxy's (`@graft/proxy/types`):
 * `CredentialScope` is the two ids a ciphertext is bound to, `CredentialFields` the record the
 * handoff form collects and the scheme plugin consumes — named string fields, opaque to this file,
 * which encrypts the record whole.
 */

export type { CredentialFields, CredentialScope } from "@graft/proxy/types";

export type CredentialVault = {
  /** Fields in, ciphertext out — the write half the connection service calls. */
  encrypt(fields: CredentialFields, scope: CredentialScope): Promise<Buffer>;
  /**
   * Ciphertext in, fields out — the proxy's half. Throws `CredentialScopeMismatchError` when the
   * ciphertext was minted for another row, `CredentialCiphertextError` when the bytes are not an
   * envelope this vault's keyring can open, and the cipher's own error when it was tampered with.
   */
  decrypt(ciphertext: Uint8Array, scope: CredentialScope): Promise<CredentialFields>;
};

/**
 * The encrypt half on its own — what the connection service's seam accepts, so a `decrypt` reached
 * from a request path is a compile error rather than a habit. The proxy's seam takes the whole
 * `CredentialVault`.
 */
export type EncryptOnlyVault = Pick<CredentialVault, "encrypt">;

/**
 * How long an unwrapped data key stays usable. Five minutes bounds how long a decrypted data key
 * sits in process memory after the last call that needed it; the capacity bounds the map. Both are
 * conservative — a miss costs one keyring round trip, not a failure.
 */
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CACHE_CAPACITY = 100;

/**
 * A credential record is a handful of short strings. The bounds exist so that neither side can be
 * handed a multi-megabyte value and stream it through the cipher: the plaintext cap refuses an
 * absurd record before the keyring is asked for a key, and the ciphertext cap refuses a swollen
 * column before it is parsed.
 */
const MAX_PLAINTEXT_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;

/** Marks the context entries as this vault's, beside the two ids. */
const CONTEXT_PURPOSE = "graft:connection-credential";

export function contextFor(scope: CredentialScope): EncryptionContext {
  return {
    purpose: CONTEXT_PURPOSE,
    personId: scope.personId,
    connectionId: scope.connectionId,
  };
}

/** The ciphertext decrypted, but was minted for a different person or connection. */
export class CredentialScopeMismatchError extends Error {
  constructor(public readonly field: string) {
    super(`credential ciphertext was not encrypted for this ${field}`);
    this.name = "CredentialScopeMismatchError";
  }
}

/** The bytes decrypted to something that is not a record of string fields. */
export class CredentialShapeError extends Error {
  constructor() {
    super("credential plaintext is not a record of string fields");
    this.name = "CredentialShapeError";
  }
}

/** The bytes are not an envelope this vault can read — malformed, or another keyring's. */
export class CredentialCiphertextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCiphertextError";
  }
}

function parseFields(plaintext: Buffer): CredentialFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new CredentialShapeError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialShapeError();
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string") throw new CredentialShapeError();
  }
  return parsed as CredentialFields;
}

/**
 * The envelope, version 1:
 *
 *   u8 version | u16 keyring id length, keyring id | u16 context length, canonical context JSON |
 *   u16 wrapped key length, wrapped data key | 12-byte IV | 16-byte tag | AES-256-GCM ciphertext
 *
 * Everything up to the wrapped key is the header, and the header is the body's additional
 * authenticated data — so the version, the keyring name, the context and the wrapped key are all
 * covered by the body's tag, and the context is covered again by the keyring's own wrap. The
 * context is in the clear on purpose: the ids are not secret, and reading them without the key is
 * what lets `decrypt` refuse a misplaced ciphertext before asking the keyring for anything.
 */
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Envelope = {
  header: Buffer;
  keyringId: string;
  context: EncryptionContext;
  wrapped: Buffer;
  iv: Buffer;
  tag: Buffer;
  body: Buffer;
};

function lengthPrefixed(bytes: Buffer): Buffer {
  if (bytes.byteLength > 0xffff) throw new Error("envelope field too long");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function encodeHeader(keyringId: string, context: EncryptionContext, wrapped: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    lengthPrefixed(Buffer.from(keyringId, "utf8")),
    lengthPrefixed(canonicalContext(context)),
    lengthPrefixed(Buffer.from(wrapped)),
  ]);
}

function decodeEnvelope(ciphertext: Uint8Array): Envelope {
  const bytes = Buffer.from(ciphertext);
  const malformed = () => new CredentialCiphertextError("credential ciphertext is malformed");
  let offset = 0;
  const take = (length: number): Buffer => {
    if (offset + length > bytes.byteLength) throw malformed();
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const takePrefixed = (): Buffer => take(take(2).readUInt16BE());

  if (bytes.byteLength < 1 || bytes[0] !== FORMAT_VERSION) {
    throw new CredentialCiphertextError("credential ciphertext is not a version 1 envelope");
  }
  offset = 1;
  const keyringId = takePrefixed().toString("utf8");
  const contextJson = takePrefixed();
  const wrapped = takePrefixed();
  const header = bytes.subarray(0, offset);
  const iv = take(IV_BYTES);
  const tag = take(TAG_BYTES);
  const body = bytes.subarray(offset);

  let context: unknown;
  try {
    context = JSON.parse(contextJson.toString("utf8"));
  } catch {
    throw malformed();
  }
  if (typeof context !== "object" || context === null || Array.isArray(context)) throw malformed();
  for (const value of Object.values(context)) {
    if (typeof value !== "string") throw malformed();
  }
  return { header, keyringId, context: context as EncryptionContext, wrapped, iv, tag, body };
}

/**
 * A vault over any keyring. The one constructor both the real deployment and the tests use, so a
 * test proves the same code path production runs, with only the wrapping key swapped.
 */
export function createCredentialVault(
  keyring: Keyring,
  options: { now?: () => number } = {},
): CredentialVault {
  const now = options.now ?? Date.now;
  const dataKeys = new Map<string, { key: Buffer; expiresAt: number }>();

  const cacheKey = (envelope: Pick<Envelope, "keyringId" | "wrapped" | "context">) =>
    createHash("sha256")
      .update(envelope.keyringId)
      .update(envelope.wrapped)
      .update(canonicalContext(envelope.context))
      .digest("hex");

  const unwrap = async (envelope: Envelope): Promise<Buffer> => {
    const id = cacheKey(envelope);
    const cached = dataKeys.get(id);
    if (cached && cached.expiresAt > now()) return cached.key;
    dataKeys.delete(id);
    const key = Buffer.from(await keyring.unwrapDataKey(envelope.wrapped, envelope.context));
    if (key.byteLength !== DATA_KEY_BYTES) {
      throw new CredentialCiphertextError("the keyring answered a data key of the wrong size");
    }
    if (dataKeys.size >= CACHE_CAPACITY) {
      const oldest = dataKeys.keys().next().value;
      if (oldest !== undefined) dataKeys.delete(oldest);
    }
    dataKeys.set(id, { key, expiresAt: now() + CACHE_MAX_AGE_MS });
    return key;
  };

  return {
    async encrypt(fields, scope) {
      const plaintext = Buffer.from(JSON.stringify(fields), "utf8");
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new Error(`credential record exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
      }
      const context = contextFor(scope);
      const dataKey = await keyring.generateDataKey(context);
      if (dataKey.plaintext.byteLength !== DATA_KEY_BYTES) {
        throw new Error("the keyring produced a data key of the wrong size");
      }
      const header = encodeHeader(keyring.id, context, dataKey.wrapped);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", dataKey.plaintext, iv);
      cipher.setAAD(header);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
    },

    async decrypt(ciphertext, scope) {
      if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
        throw new Error(`credential ciphertext exceeds ${MAX_CIPHERTEXT_BYTES} bytes`);
      }
      const envelope = decodeEnvelope(ciphertext);
      if (envelope.keyringId !== keyring.id) {
        throw new CredentialCiphertextError(
          `credential ciphertext was wrapped by the ${envelope.keyringId} keyring, not ${keyring.id}`,
        );
      }
      // The header's context is compared before the keyring is asked — a misplaced ciphertext costs
      // no round trip — and authenticated by the two decrypts that follow, so a header rewritten to
      // match this row fails on the tag rather than passing here.
      for (const [key, value] of Object.entries(contextFor(scope))) {
        if (envelope.context[key] !== value) throw new CredentialScopeMismatchError(key);
      }
      const dataKey = await unwrap(envelope);
      const decipher = createDecipheriv("aes-256-gcm", dataKey, envelope.iv);
      decipher.setAAD(envelope.header);
      decipher.setAuthTag(envelope.tag);
      const plaintext = Buffer.concat([decipher.update(envelope.body), decipher.final()]);
      return parseFields(plaintext);
    },
  };
}
