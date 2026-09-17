import type { Database } from "@graft/db";
import * as schema from "@graft/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * `@graft/auth` — the **person**'s account (CONTEXT.md, ADR 0007), on Better Auth over drizzle.
 *
 * A person is Better Auth's user and nothing more: no organization plugin, because the person is
 * the outermost boundary in the schema and the org tier is a column awaiting a UI (ADR 0007). Email
 * and password always; Google and GitHub when the deployment hands their OAuth clients in (GRA-81,
 * ADR 0020) — registered by conditional spread, because Better Auth advertises a provider the moment
 * its key exists, credentials or not, and the console draws a button per provider the server names.
 * The four tables the library owns are generated into `@graft/db`'s schema by
 * `pnpm --filter @graft/auth generate-schema` — regenerate rather than hand-edit them when this
 * configuration changes.
 *
 * A function of what it is handed rather than of the environment, like `createServer`: the
 * server reads `@graft/env` and passes the values in, so a test builds an instance over a test
 * database with no `.env` and no `process.env`.
 */

/** The providers a person may sign in with beside email and password; the console's buttons. */
export const SOCIAL_PROVIDER_NAMES = ["google", "github"] as const;
export type SocialProviderName = (typeof SOCIAL_PROVIDER_NAMES)[number];

/** One provider's OAuth client — `GRAFT_GOOGLE_CLIENT_*` or `GRAFT_GITHUB_CLIENT_*` (`@graft/env`). */
export type SocialProviderClient = { clientId: string; clientSecret: string };

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
  /**
   * The sign-in providers this deployment has clients for, a key per configured provider and no key
   * for an absent one (`@graft/env`'s `signInProvidersFrom`). Each redirect URI is `baseURL` plus
   * `/api/auth/callback/<provider>`.
   */
  socialProviders?: Partial<Record<SocialProviderName, SocialProviderClient>>;
};

export function createAuth(options: CreateAuthOptions) {
  const { google, github } = options.socialProviders ?? {};
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
       * arrives, flip this and add `emailVerification.sendVerificationEmail` beside it. Until then
       * a sign-up opens a session at once — and, one consequence ADR 0020 spells out, a social
       * sign-in cannot yet attach to a password account, whose address nobody has verified.
       */
      requireEmailVerification: false,
    },
    /**
     * A provider key present is a provider advertised — `/api/auth/sign-in/social` accepts it and
     * the console lists it — so an unconfigured one is absent, not `undefined`.
     */
    socialProviders: {
      ...(google ? { google } : {}),
      ...(github ? { github } : {}),
    },
    account: {
      accountLinking: {
        /**
         * ADR 0020: a social sign-in for an address that already has an account attaches to that
         * account rather than being refused — when the provider says the address is verified
         * (Google's `email_verified`, GitHub's verified flag on the address) **and** the account's
         * own address is verified. Both are Better Auth's defaults, written down here because the
         * second is what stands between a squatted sign-up and a takeover while verification is
         * off above: an unverified password account never links, whatever the provider says.
         * No provider is trusted blanket (`trustedProviders`), so the first condition is judged
         * per address, not per vendor.
         */
        enabled: true,
        requireLocalEmailVerified: true,
      },
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
