import { ServiceError } from "@graft/core";
import type { MiddlewareHandler } from "hono";

/**
 * The origin check on `/api` (GRA-148). A state-changing request that authenticates by the
 * session cookie has to come from an origin this deployment serves the console on; anything else
 * is 403 before the route sees it.
 *
 * Why it is needed at all: the console is same-origin with the API (`console.ts`), so nothing in
 * the browser ever legitimately calls `/api` from elsewhere, and nothing here checked. A page on
 * another site could therefore `fetch` a `POST` with `credentials: "include"` and, kept to
 * CORS's "simple request" shape, never face a preflight the browser would refuse: the request
 * left, the cookie went with it, and the route ran. `PUT /api/me/model-key` was the worst of
 * them: it repoints the person's authoring model at any base URL, so every vendor page an
 * `acquire` job reads would go to whoever wrote the page (ADR 0014). This guard and `parseBody`'s
 * content-type rule are the two halves of closing that: the guard refuses the request, and the
 * content-type rule takes the route out of the "simple request" set so a browser would have
 * preflighted it in the first place.
 *
 * Not the cookie's job. `sameSite` is a second line and a weaker one: `@graft/auth`'s
 * `sessionCookieAttributes` makes it `lax` for the one-origin form, but a console served from
 * another origin needs `none`, and this check is what holds in that deployment too.
 *
 * Reads are not checked. A cross-site `GET` cannot be made to matter here: every read answers
 * JSON the other page cannot parse without CORS, and `cors()` writes no header for an origin
 * this deployment does not name. `OPTIONS` is the preflight itself.
 */

/** Methods that change nothing, and are therefore not checked. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The paths under `/api` this check does not apply to, each with the reason it does not. Every
 * other route under `/api` authenticates by the session cookie and nothing else. There is no
 * bearer-token route beneath this mount but the proxy's, because the MCP endpoint and the OAuth
 * protocol endpoints answer outside `/api` (`app.ts`, `MCP_MOUNT_PATH` and `MCP_OAUTH_MOUNT_PATH`).
 * The consent (`POST /api/mcp-oauth/consent`) and the four pending-action submits are deliberately
 * *not* here: they are the person's answer, made in the console with the person's session, and an
 * answer another site could post is exactly the thing ADR 0006 says only the person gives.
 */
export const ORIGIN_GUARD_EXEMPTIONS = [
  {
    prefix: "/api/proxy",
    why: "The proxy's caller is a sandbox process presenting a capability token, never a browser with a cookie (ADR 0010). `app.ts` mounts it above this app, so a matched proxy request never reaches here; the entry covers a path that falls through.",
  },
  {
    prefix: "/api/auth",
    why: "Better Auth runs the same check itself, against its own `trustedOrigins`: `originCheckMiddleware` is registered at `/**` on its router (better-auth 1.7.5, `dist/api/index.mjs`) and validates `Origin`, then `Referer`, on every non-GET request that carries a cookie (`dist/api/middlewares/origin-check.mjs`); the router admits `application/json` alone besides. Checking twice would mean two lists of trusted origins to keep in step.",
  },
  {
    prefix: "/api/health",
    why: "Liveness for the compose file's health check and a load balancer's (GRA-33): no session, and nothing it could change.",
  },
] as const;

export type OriginGuardOptions = {
  /**
   * `GRAFT_AUTH_URL`, the origin this server answers on, which is the console's too in the
   * one-origin form. Optional only because `ApiOptions.authUrl` is; `index.ts` always binds it,
   * and without it the console's own origin is trusted through `Sec-Fetch-Site` alone.
   */
  authUrl?: string;
  /** `GRAFT_CORS_ORIGIN`, a console answering somewhere else, already checked to be origins. */
  corsOrigins: readonly string[];
};

/** The origin the request claims, by `Origin` and then by `Referer`; null when it claims none. */
export function claimedOrigin(headers: Headers): string | null {
  const origin = headers.get("origin");
  // `null` is the literal a browser sends for an opaque origin: a sandboxed iframe, or a
  // redirected form post. It names no origin, so it is not one to compare; `Sec-Fetch-Site` decides instead.
  if (origin !== null && origin !== "" && origin !== "null") return origin;
  const referer = headers.get("referer");
  if (referer === null || referer === "") return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * The middleware. Mounted over all of `/api` by `createApi`, above every route and above the
 * analytics chokepoint, so a refused request resolves no session and counts nothing.
 */
export function createOriginGuard(options: OriginGuardOptions): MiddlewareHandler {
  const allowed = new Set<string>(options.corsOrigins);
  if (options.authUrl !== undefined) allowed.add(new URL(options.authUrl).origin);

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    const path = new URL(c.req.url).pathname;
    const exempt = ORIGIN_GUARD_EXEMPTIONS.some(
      ({ prefix }) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (exempt) return next();

    const claimed = claimedOrigin(c.req.raw.headers);
    if (claimed === null) {
      // No origin named. A browser sends one on every state-changing request, so this is either a
      // same-origin navigation the fetch metadata vouches for or a caller that is not a browser.
      if (c.req.raw.headers.get("sec-fetch-site") === "same-origin") return next();
      throw new ServiceError(
        "FORBIDDEN",
        "This request names no origin, and a state-changing call to the API has to come from the console's",
      );
    }
    if (allowed.has(claimed)) return next();
    throw new ServiceError(
      "FORBIDDEN",
      `${claimed} is not an origin this deployment serves the console on, so a state-changing call from it is refused`,
    );
  };
}
