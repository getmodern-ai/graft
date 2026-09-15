import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { TokenResponse } from "./mcp-oauth.service";

/**
 * The retry-safe half of refresh rotation (ADR 0018; OAuth 2.1 §4.3.1). When a refresh token is
 * rotated, the successor pair it earned is **sealed under a key derived from the retired token
 * itself** and kept on the retired row for the grace window. A client whose refresh succeeded but
 * whose response was lost holds exactly one thing — the retired token — and presenting it again
 * opens the seal and answers the same pair, so the grant survives a dropped response without the
 * person consenting again. Nobody else can open it: the database holds the retired token's hash
 * and this ciphertext, and neither yields the other. An attacker holding the retired token gains
 * nothing they did not have — that token could have been refreshed by them a moment earlier.
 *
 * AES-256-GCM under an HKDF-SHA256 key from the token, the row's id as the info so a ciphertext
 * copied onto another row does not open; a fresh nonce per seal; the value stored is
 * `base64url(nonce ‖ ciphertext ‖ tag)`. Pure functions over strings, tested on their own.
 */

const SALT = "graft-mcp-rotation-replay";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function keyFor(retiredToken: string, tokenRowId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", retiredToken, SALT, tokenRowId, 32));
}

/** Seal the successor pair under the retired token; what `rotateMcpToken`'s winner stores. */
export function sealRotationReplay(
  retiredToken: string,
  tokenRowId: string,
  successor: TokenResponse,
  random: (bytes: number) => Buffer = randomBytes,
): string {
  const nonce = random(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(retiredToken, tokenRowId), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(successor), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
}

/**
 * Open a seal with the retired token presented again. Null for anything but the exact pair of
 * token and row it was sealed under — a wrong token, another row, a tampered value, a value that
 * was never a seal — so the caller refuses rather than guesses.
 */
export function openRotationReplay(
  retiredToken: string,
  tokenRowId: string,
  sealed: string | null | undefined,
): TokenResponse | null {
  if (!sealed) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(sealed, "base64url");
  } catch {
    return null;
  }
  if (raw.length <= NONCE_BYTES + TAG_BYTES) return null;
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(retiredToken, tokenRowId), nonce);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    return isTokenResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === "string" &&
    typeof v.refresh_token === "string" &&
    v.token_type === "Bearer" &&
    typeof v.expires_in === "number"
  );
}
