import { createAuthClient } from "better-auth/react";

/**
 * Better Auth's client, pointed at the server's own mount (`apps/server/src/api.ts`, `/api/auth/*`).
 * Same-origin by construction: in development Vite proxies `/api` to the server, in production the
 * server serves this app, so the base is this page's origin and the session cookie never crosses
 * one (GRA-26). The path has to equal the server-side mount — the client derives its route matching
 * from it.
 */
export const authClient = createAuthClient({
  baseURL: new URL("/api/auth", window.location.origin).toString(),
});

export type Session = NonNullable<Awaited<ReturnType<typeof authClient.getSession>>["data"]>;
