import { credentialIncompleteRefusal, type SchemePlugin } from "./schemes";
import type { SchemeConfig } from "./types";

export type { DryRunOutcome } from "./types";

/**
 * The dry run (CONTEXT.md: reads reach the vendor and every other method stops at the proxy, which
 * answers with a preview of the request that would have left).
 *
 * A capability token may carry `dryRun: true`. With it, the proxy runs every check it runs today,
 * forwards `GET` and `HEAD` exactly as a normal call, and stops every other method here, answering
 * a **preview** rather than anything a vendor said. The claim is the guarantee, not the client: a
 * module that bypasses the runner's fetch — or an SDK bound to the proxy (ADR 0010) — still cannot
 * write during a dry run, because the proxy is what reads the token. This file holds the pure parts
 * — the marker, the status, the preview's shape and how it is built; `app.ts` decides where in the
 * ladder the interception sits.
 */

/**
 * Set on every dry-run answer, so a reader can tell the two outcomes apart without parsing the
 * body: `forwarded` on a read that reached the vendor (the rest of the response is the vendor's),
 * `intercepted` on a write that stopped here (the body is the preview).
 */
export const DRY_RUN_HEADER = "x-graft-dry-run";

/**
 * 202 Accepted for an intercepted write. RFC 9110 §15.3.3 defines it as a request that has been
 * accepted and understood but whose processing is not complete and "might or might not eventually
 * be acted upon" — the one 2xx whose meaning is *understood, not performed*. A 2xx so a module's
 * `response.ok` check passes and its code carries on to the point the runner can report; not 200,
 * 201 or 204, which are what a completed write answers, so a module that checks for `201 Created`
 * reads an honest "no" rather than a fabricated "yes". The proxy never fabricates a vendor response.
 */
export const DRY_RUN_PREVIEW_STATUS = 202;

/**
 * The two RFC 9110 §9.2.1 methods safe by definition — what a dry run lets through to the vendor.
 * The ladder reads the same pair as the methods with no body to buffer, and the ones a 301 or 302
 * keeps rather than turning into a GET (`redirects.ts`), so it is one set.
 */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * What an intercepted write answers — the request as it would have left, minus every value that
 * is not the caller's to see. Header *names* only, sorted and lower-cased: the credential the
 * proxy would have injected is among them by name, so the agent can see that authentication would
 * have been present, and never by value. `host` is the vendor hostname the request would have gone
 * to — the primary, or the one the explicit form named — and `path` the resolved path there (the
 * primary's base path plus the caller's, or the caller's alone under the explicit form). `hasQuery`
 * says whether a query string was present without repeating it — a scheme may put the key there.
 * The body is the caller's own, already read under the proxy's cap, as UTF-8 when it decodes as
 * such and base64 otherwise.
 */
export type DryRunPreview = {
  dryRun: true;
  intercepted: true;
  request: {
    method: string;
    host: string;
    path: string;
    hasQuery: boolean;
    headerNames: string[];
    bodyBytes: number;
    body: string;
    bodyEncoding: "utf-8" | "base64";
  };
};

export type DryRunPreviewInput = {
  method: string;
  /** The vendor URL the request would have gone to: `hostname`, `pathname` and `search` are read. */
  url: URL;
  /** Every header name the request would have carried, the scheme's included; any case, any order. */
  headerNames: Iterable<string>;
  body: Uint8Array | null;
};

export function buildDryRunPreview(input: DryRunPreviewInput): DryRunPreview {
  const bytes = input.body ?? new Uint8Array(0);
  const decoded = decodeUtf8(bytes);
  return {
    dryRun: true,
    intercepted: true,
    request: {
      method: input.method,
      host: input.url.hostname,
      path: input.url.pathname,
      hasQuery: input.url.search.length > 1,
      headerNames: [...new Set([...input.headerNames].map((name) => name.toLowerCase()))].sort(),
      bodyBytes: bytes.byteLength,
      body: decoded ?? Buffer.from(bytes).toString("base64"),
      bodyEncoding: decoded === null ? "base64" : "utf-8",
    },
  };
}

/** The bytes as text when they are well-formed UTF-8, null when they are not. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type SchemeHeaderNames =
  | { ok: true; headerNames: string[] }
  | { ok: false; reason: "credential_incomplete"; message: string };

/**
 * The names of every header the request would have carried: the caller's, after the outgoing
 * policy has run, plus the ones the scheme names for this configuration
 * (`SchemePlugin.headerNames`). A dry run of a write never decrypts a credential or exchanges a
 * token — the request is not leaving — so the scheme is asked what it *would* set rather than made
 * to set it. A scheme whose configuration is incomplete refuses here exactly as a live call would
 * after decrypting (`credential_incomplete`): the request would not have left either way, and the
 * dry run should say so rather than preview a request the proxy could not have sent.
 */
export function schemeHeaderNames(
  headers: Headers,
  plugin: SchemePlugin,
  config: SchemeConfig,
): SchemeHeaderNames {
  let added: readonly string[];
  try {
    added = plugin.headerNames(config);
  } catch (error) {
    const refusal = credentialIncompleteRefusal(error);
    if (refusal) return { ok: false, ...refusal };
    throw error;
  }
  return { ok: true, headerNames: [...new Set([...headers.keys(), ...added])] };
}
