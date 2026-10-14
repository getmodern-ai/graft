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
 * It also carries the two choices the link's card offers (GRA-75 and GRA-239; ADR 0008,
 * amendments of 2026-09-18 and 2026-10-09): whether the asking agent may build against the
 * connection once it exists, and whether the integration's tools run for it without asking,
 * destructive ones left out. The person ticks them before the popup opens, and the connection it is about is made on return, so
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
  /** Record the asking agent's standing approval for the vendor on return (GRA-239); absent reads as no. */
  allowVendor?: boolean;
};

/**
 * The console's own connect (ADR 0006 as amended 2026-10-14; GRA-304): a link the person started
 * from the console with no agent asking, so there is no ask to name. **The state is the
 * short-lived record**: what the return needs to make the connection (the proposal routed, the
 * person, the provider, the access chosen) travels signed in it, so any replica can finish a link
 * another started and nothing is written until the provider confirms the account. `connectId` is
 * the record's id, answered to the console when the link is minted and handed back on the
 * console's callback, so the page that opened the popup knows the outcome is its own.
 */
export type ConsoleLinkStatePayload = {
  connectId: string;
  personId: string;
  provider: string;
  vendor: string;
  displayName: string;
  primaryHost: string;
  hosts: string[];
  /** ADR 0008's amendment of 2026-10-14: `full` records the agents' approvals with the row. */
  access: "full" | "ask";
  /** Epoch milliseconds. */
  expiresAt: number;
};

type StateDomain = "link" | "connect";

function mark(domain: StateDomain, encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${domain}\n${encodedPayload}`).digest();
}

function sign(domain: StateDomain, payload: object, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${mark(domain, encoded, secret).toString("base64url")}`;
}

/** `base64url(payload JSON) + "." + base64url(HMAC)` — one string for the provider to carry back. */
export function signLinkState(payload: LinkStatePayload, secret: string): string {
  return sign("link", payload, secret);
}

/** The console connect's state, under its own domain so neither state verifies as the other. */
export function signConsoleLinkState(payload: ConsoleLinkStatePayload, secret: string): string {
  return sign("connect", payload, secret);
}

/**
 * An expired state is one this server signed, so it carries its payload for the caller to say
 * which attempt it was (GRA-304: the console matches the outcome by `connectId`); it authorises
 * nothing.
 */
export type StateVerdict<P> =
  | { ok: true; payload: P }
  | { ok: false; reason: "malformed" | "tampered"; message: string }
  | { ok: false; reason: "expired"; message: string; payload: P };

export type LinkStateVerdict = StateVerdict<LinkStatePayload>;
export type ConsoleLinkStateVerdict = StateVerdict<ConsoleLinkStatePayload>;

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
  return verify("link", state, secret, now, isPayload);
}

/**
 * Verify a console connect's state (GRA-304). `tampered` is also what a link state of the other
 * domain reads as here, which is how the return route tells the two apart: only a state this
 * domain signed answers `ok` or `expired`.
 */
export function verifyConsoleLinkState(
  state: string | null | undefined,
  secret: string,
  now: Date,
): ConsoleLinkStateVerdict {
  return verify("connect", state, secret, now, isConsolePayload);
}

function verify<P extends { expiresAt: number }>(
  domain: StateDomain,
  state: string | null | undefined,
  secret: string,
  now: Date,
  isShape: (value: unknown) => value is P,
): StateVerdict<P> {
  const malformed: StateVerdict<P> = {
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

  const expected = mark(domain, encoded, secret);
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
  if (!isShape(payload)) return malformed;
  if (payload.expiresAt <= now.getTime()) {
    return {
      ok: false,
      reason: "expired",
      message:
        domain === "link"
          ? "This link took too long — open the ask in the console and connect again"
          : "This link took too long. Connect the integration again from the console",
      payload,
    };
  }
  return { ok: true, payload };
}

function isConsolePayload(value: unknown): value is ConsoleLinkStatePayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const text = (key: string) => typeof p[key] === "string" && (p[key] as string).length > 0;
  return (
    text("connectId") &&
    text("personId") &&
    text("provider") &&
    text("vendor") &&
    text("displayName") &&
    text("primaryHost") &&
    Array.isArray(p.hosts) &&
    p.hosts.every((host) => typeof host === "string") &&
    (p.access === "full" || p.access === "ask") &&
    typeof p.expiresAt === "number" &&
    Number.isFinite(p.expiresAt)
  );
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
    (p.approveBuild === undefined || typeof p.approveBuild === "boolean") &&
    (p.allowVendor === undefined || typeof p.allowVendor === "boolean")
  );
}
