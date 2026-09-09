import type { Database } from "@graft/db";
import * as schema from "@graft/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * `@graft/auth` — the **person**'s account (CONTEXT.md, ADR 0007), on Better Auth over drizzle.
 *
 * A person is Better Auth's user and nothing more: no organization plugin, because the person is
 * the outermost boundary in the schema and the org tier is a column awaiting a UI (ADR 0007), and
 * no social provider, because Google sign-in is "optional later" in GRA-1 and a provider key that
 * is present is a provider Better Auth advertises. The four tables the library owns are generated
 * into `@graft/db`'s schema by `pnpm --filter @graft/auth generate-schema` — regenerate rather than
 * hand-edit them when this configuration changes.
 *
 * A function of what it is handed rather than of the environment, like `createServer`: the
 * server reads `@graft/env` and passes the values in, so a test builds an instance over a test
 * database with no `.env` and no `process.env`.
 */

export type CreateAuthOptions = {
  db: Database;
  /** `GRAFT_AUTH_SECRET` — signs cookies and tokens; 32+ characters, checked by `@graft/env`. */
  secret: string;
  /** `GRAFT_AUTH_URL` — the server's public origin, where Better Auth's own routes answer. */
  baseURL: string;
  /**
   * The console's origins (`GRAFT_CORS_ORIGIN`). Better Auth refuses a state-changing request
   * from any origin outside this list, so an unlisted console can render but never sign in.
   */
  trustedOrigins?: readonly string[];
};

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: "pg", schema }),
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: [...(options.trustedOrigins ?? [])],
    emailAndPassword: {
      enabled: true,
      /**
       * **Off for the alpha, on purpose, and to be revisited before public launch.** The alpha's
       * persons are invited by hand and known to us, and the self-hosted image bootstraps its one
       * admin from environment variables (GRA-1, user story 28) — a verification email there would
       * be a mail transport to configure on day one of a laptop install, for an address the
       * operator typed themselves. Nothing in this repository sends mail yet; when a transport
       * arrives with the console (GRA-26), flip this and add `emailVerification.sendVerificationEmail`
       * beside it. Until then a sign-up opens a session at once.
       */
      requireEmailVerification: false,
    },
    advanced: {
      /**
       * The console is a separate origin from the API in development (two ports), so the session
       * cookie has to cross origins: `sameSite: "none"` requires `secure`, and `httpOnly` keeps it
       * out of the console's scripts. `secure` cookies still work on `localhost`, which browsers
       * treat as a secure context.
       */
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** A resolved session — what `auth.api.getSession` answers, null when no cookie names a live one. */
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
