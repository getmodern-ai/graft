import { createHmac, timingSafeEqual } from "node:crypto";

import { LINK_STATE_TTL_MS } from "./link.rules";

/**
 * The signed state a provider's link carries back (ADR 0019; GRA-59) — `oauth-consent.ts`'s state
 * for a consent, applied to a link: the return route has no session, because the browser arrives
 * from the provider's page, so the state is the whole authority on which ask, for which person, the
 * returning browser is finishing. An HMAC-SHA256 under `GRAFT_HANDOFF_SECRET` — the secret that
 * signs a handoff URL and a consent's state, for the same reason: the browser carries it, so it
 * proves the link is one Graft issued — over a payload that travels with it, base64url'd.
 *
 * It names the **ask**, not a connection: a link's connection does not exist until the return
 * confirms what the person connected (`connection.service.ts`, `connectThroughProvider`), so the
 * ask is what the state points at and what the return route answers. The nonce makes two links for
 * one ask two states; a return with a stale one is refused as expired rather than replayed.
 *
 * It also carries the one choice the link's card offers (GRA-75; ADR 0008, amendment of
 * 2026-09-18): whether the asking agent may build against the connection once it exists. The
 * person ticks it before the popup opens, and the connection it is about is made on return, so
 * the choice rides the state to the return route, signed, rather than being posted again from a
 * page that no longer has the person's session in hand.
 */

export { LINK_STATE_TTL_MS };

export type LinkStatePayload = {
  pendingActionId: string;
  personId: string;
  /** The provider the ask was routed to — checked against the ask on return, never trusted alone. */
  provider: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  nonce: string;
  /** Record the asking agent's build approval with the connection on return (GRA-75); absent reads as no. */
  approveBuild?: boolean;
};

function mark(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`link\n${encodedPayload}`).digest();
}

/** `base64url(payload JSON) + "." + base64url(HMAC)` — one string for the provider to carry back. */
export function signLinkState(payload: LinkStatePayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${mark(encoded, secret).toString("base64url")}`;
}

export type LinkStateVerdict =
  | { ok: true; payload: LinkStatePayload }
  | { ok: false; reason: "malformed" | "tampered" | "expired"; message: string };

/**
 * Verify a state the provider carried back. The mark is checked first and in constant time, so a
 * forged state learns nothing about any ask; then the expiry. A payload whose shape is not the one
 * this server signs is `malformed` — it cannot have come from `signLinkState`. The domain prefix in
 * `mark` keeps a consent's state (`oauth-consent.ts`) from verifying here and this one from
 * verifying there, though the two payloads' shapes already differ.
 */
export function verifyLinkState(
  state: string | null | undefined,
  secret: string,
  now: Date,
): LinkStateVerdict {
  const malformed: LinkStateVerdict = {
    ok: false,
    reason: "malformed",
    message: "The state the provider sent back is not one Graft issued",
  };
  if (!state) return malformed;
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return malformed;
  const encoded = state.slice(0, dot);
  const presented = state.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(presented)) return malformed;

  const expected = mark(encoded, secret);
  const given = Buffer.from(presented, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return {
      ok: false,
      reason: "tampered",
      message: "The state the provider sent back is not one Graft issued",
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return malformed;
  }
  if (!isPayload(payload)) return malformed;
  if (payload.expiresAt <= now.getTime()) {
    return {
      ok: false,
      reason: "expired",
      message: "This link took too long — open the ask in the console and connect again",
    };
  }
  return { ok: true, payload };
}

function isPayload(value: unknown): value is LinkStatePayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.pendingActionId === "string" &&
    p.pendingActionId.length > 0 &&
    typeof p.personId === "string" &&
    p.personId.length > 0 &&
    typeof p.provider === "string" &&
    p.provider.length > 0 &&
    typeof p.expiresAt === "number" &&
    Number.isFinite(p.expiresAt) &&
    typeof p.nonce === "string" &&
    (p.approveBuild === undefined || typeof p.approveBuild === "boolean")
  );
}
