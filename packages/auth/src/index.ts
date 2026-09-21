import type { Database } from "@graft/db";
import * as schema from "@graft/db/schema/auth";
import {
  buildLoginUrl,
  buildPasswordResetUrl,
  type EmailTransport,
  sendAccountExistsEmail,
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
} from "@graft/email";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * `@graft/auth` — the **person**'s account (CONTEXT.md, ADR 0007), on Better Auth over drizzle.
 *
 * A person is Better Auth's user and nothing more: no organization plugin, because the person is
 * the outermost boundary in the schema and the org tier is a column awaiting a UI (ADR 0007). Email
 * and password always; Google and GitHub when the deployment hands their OAuth clients in (GRA-81,
 * ADR 0020) — registered by conditional spread, because Better Auth advertises a provider the moment
 * its key exists, credentials or not, and the console draws a button per provider the server names;
 * and, when a transport is handed in, the account's three emails through `@graft/email` — the
 * reset (GRA-82), the verification a registration waits on and the account-exists notice a taken
 * address earns (GRA-94; ADR 0021).
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
   * `GRAFT_CONSOLE_URL`, where the console answers. Read for the session cookie's attributes
   * alone (`sessionCookieAttributes`); absent means the console is this origin, which is what a
   * script or a test that serves no console wants.
   */
  consoleUrl?: string;
  /**
   * The sign-in providers this deployment has clients for, a key per configured provider and no key
   * for an absent one (`@graft/env`'s `signInProvidersFrom`). Each redirect URI is `baseURL` plus
   * `/api/auth/callback/<provider>`.
   */
  socialProviders?: Partial<Record<SocialProviderName, SocialProviderClient>>;
  /**
   * The mail the account sends (ADR 0021; GRA-82, GRA-94): the console's origin every emailed link
   * to a console route is built on (`GRAFT_CONSOLE_URL`, as every handoff URL is — ADR 0006) and the
   * transport that carries it (`Backings.mail`). Optional so a test or a script that sends nothing
   * builds no mail stack; absent, the three hooks below are not registered and Better Auth logs that
   * nothing was configured to send.
   */
  mail?: { consoleUrl: string; transport: EmailTransport };
};

/** Where the console and the API answer, as the three variables that decide it spell them. */
export type DeploymentOrigins = {
  /** `GRAFT_AUTH_URL`, the server's public origin. */
  authUrl: string;
  /** `GRAFT_CONSOLE_URL`; absent means the console is served from the API's own origin. */
  consoleUrl?: string;
  /** `GRAFT_CORS_ORIGIN`, a console answering somewhere else again. */
  corsOrigins?: readonly string[];
};

/** The session cookie's attributes; `httpOnly` always, the other two follow the deployment. */
export type SessionCookieAttributes = {
  sameSite: "lax" | "none";
  secure: boolean;
  httpOnly: true;
};

/**
 * The session cookie, as a function of where the console and the API answer (GRA-148).
 *
 * `sameSite: "none"` was unconditional until this function, for the two-port development setup,
 * and it is the wrong default for the form every self-host and Graft Cloud run: the console is
 * served by this server (`apps/server/src/console.ts`), so the cookie never crosses an origin and
 * `lax` is what it should be. `none` stays for a console answering elsewhere, a second origin
 * named by `GRAFT_CONSOLE_URL` or admitted by `GRAFT_CORS_ORIGIN`, because nothing else reaches
 * it. Note that the cookie is not what stands between a cross-site request and this API: the
 * origin check on `/api` is (`apps/server/src/origin-guard.ts`).
 *
 * `secure` follows the scheme rather than being always on. A self-host on a plain `http://` LAN
 * address is a form ADR 0002 admits, and an always-`secure` cookie made its sign-in silently
 * impossible: the browser accepts the response and stores nothing. Cross-origin is the one case
 * that has no choice: a `sameSite: "none"` cookie must be `Secure` or the browser drops it, so
 * that branch asks for it, and the deployment where it cannot work (a console on another origin
 * over plain http that is not a loopback host) is refused at boot by `@graft/env`'s
 * `serverEnvIssues` rather than failing in the browser.
 */
export function sessionCookieAttributes(origins: DeploymentOrigins): SessionCookieAttributes {
  const apiUrl = new URL(origins.authUrl);
  const consoleOrigin = origins.consoleUrl ? new URL(origins.consoleUrl).origin : apiUrl.origin;
  const elsewhere = consoleOrigin !== apiUrl.origin || (origins.corsOrigins ?? []).length > 0;

  if (elsewhere) return { sameSite: "none", secure: true, httpOnly: true };
  return { sameSite: "lax", secure: apiUrl.protocol === "https:", httpOnly: true };
}

export function createAuth(options: CreateAuthOptions) {
  const { google, github } = options.socialProviders ?? {};
  // Narrowed once so every hook below reads the same pair; the hooks are registered only when it is set.
  const mail = options.mail ?? {
    consoleUrl: "",
    transport: { name: "none", send: async () => ({ delivered: false, transport: "none" }) },
  };
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: "pg", schema }),
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: [...(options.trustedOrigins ?? [])],
    emailAndPassword: {
      enabled: true,
      /**
       * Registering opens no session until the address is verified — GRA-94, amending ADR 0020.
       *
       * Two things ride on this one flag. First, ADR 0020's linking: Better Auth 1.7 refuses to
       * attach a Google or GitHub identity to a local user whose own `emailVerified` is false
       * (`accountLinking.requireLocalEmailVerified`, below), so without verification "Continue
       * with Google" on a password address dead-ended. Second, the enumeration oracle: with this
       * on, Better Auth itself answers a taken address exactly as a fresh one — a synthetic
       * no-session body, the password hashed on both paths for timing — and the inbox is where
       * the two cases differ (`onExistingUserSignUp`).
       *
       * Sign-in of an unverified account answers 403 `EMAIL_NOT_VERIFIED` and, with `sendOnSignIn`
       * below, re-sends the link; the doors show "check your email" for it. Accounts that predate
       * this flag are unverified too and meet the same path once — no backfill, on purpose: one
       * click of an email is the cost, and marking every pre-existing row verified would grant
       * exactly the trust the flag exists to withhold. The one exception is the admin the
       * self-hosted image opens from its environment, which the boot marks verified itself
       * (`markPersonEmailVerified`): the operator typed that address.
       */
      requireEmailVerification: true,
      ...(options.mail
        ? {
            /**
             * The reset email — a thin delegation to `@graft/email` (GRA-82; Cando's CAN-166).
             * The link is built against the *console's* origin, not Better Auth's `data.url`:
             * that URL points at the API's own GET callback, and the reset screen is a console
             * route (`/reset-password`). `resetPassword` consumes the raw token, so skipping the
             * callback loses nothing.
             *
             * A failed send must never surface to the requester: `requestPasswordReset` answers
             * identically for known and unknown addresses, and an error here would break that
             * anti-enumeration stance. Better Auth already catches a rejection from this hook
             * and logs it bare — the catch exists to log the failure *with context* instead.
             */
            sendResetPassword: async (data: {
              user: { id: string; email: string };
              token: string;
            }) => {
              const { consoleUrl, transport } = mail;
              try {
                await sendPasswordResetEmail(
                  { to: data.user.email, resetUrl: buildPasswordResetUrl(consoleUrl, data.token) },
                  transport,
                );
              } catch (error) {
                console.error("Password reset email failed — the requester was told nothing", {
                  personId: data.user.id,
                  transport: transport.name,
                  error,
                });
              }
            },
            /**
             * A sign-up naming an address already on file: the wire says "check your email" like
             * any other, and this is the email — "you already have an account, sign in" — sent to
             * the one person entitled to know (GRA-94). Better Auth awaits this hook before
             * answering; a failure is logged with context and swallowed, so the answer stays
             * identical either way.
             */
            onExistingUserSignUp: async (data: { user: { id: string; email: string } }) => {
              const { consoleUrl, transport } = mail;
              try {
                const result = await sendAccountExistsEmail(
                  { to: data.user.email, loginUrl: buildLoginUrl(consoleUrl, data.user.email) },
                  transport,
                );
                if (!result.delivered) {
                  console.error(
                    "Account-exists email was not delivered — the requester was told nothing",
                    {
                      personId: data.user.id,
                      transport: result.transport,
                    },
                  );
                }
              } catch (error) {
                console.error("Account-exists email failed — the requester was told nothing", {
                  personId: data.user.id,
                  transport: transport.name,
                  error,
                });
              }
            },
          }
        : {}),
    },
    ...(options.mail
      ? {
          emailVerification: {
            /**
             * The verification email — a thin delegation to `@graft/email` (GRA-94; Cando's
             * CAN-476). Unlike the reset link, Better Auth's `url` is passed through whole: it
             * points at the API's own `GET /verify-email`, and that GET is what marks the address
             * verified, opens the session (`autoSignInAfterVerification`) and redirects to the
             * `callbackURL` the door supplied — which Better Auth checks against `trustedOrigins`,
             * so it can only be the console. The doors pass their own URL with the search that
             * brought the person, so the `_auth` guard sends a now-verified visitor on; a dead
             * link (`?error=TOKEN_EXPIRED`) is a sentence on the door.
             *
             * A failed send is logged with context and swallowed for the reset's reason: the
             * sign-up answer must not change with whether mail left. Two failure shapes reach
             * here — a transport *resolves* `delivered: false` on a refusal or a dead network
             * rather than throwing, and a schema or URL fault throws — and both land in the log
             * with the person's id, because the person on the other side is now looking at "check
             * your email" with nothing coming. The card's resend is their recovery; this line is ours.
             */
            sendVerificationEmail: async (data: {
              user: { id: string; email: string };
              url: string;
              token: string;
            }) => {
              const { transport } = mail;
              try {
                const result = await sendEmailVerificationEmail(
                  { to: data.user.email, verifyUrl: data.url },
                  transport,
                );
                if (!result.delivered) {
                  console.error(
                    "Verification email was not delivered — the requester was told nothing",
                    {
                      personId: data.user.id,
                      transport: result.transport,
                    },
                  );
                }
              } catch (error) {
                console.error("Verification email failed — the requester was told nothing", {
                  personId: data.user.id,
                  transport: transport.name,
                  error,
                });
              }
            },
            // An unverified account trying to sign in gets a fresh link rather than a dead end.
            sendOnSignIn: true,
            // The click is the proof; asking for a password straight after it would be a second door.
            autoSignInAfterVerification: true,
            // 24 hours, not the one-hour default: someone who signs up on Friday evening must not
            // come back to a dead link.
            expiresIn: 60 * 60 * 24,
          },
        }
      : {}),
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
         * second is what stands between a squatted sign-up and a takeover: an unverified password
         * account never links, whatever the provider says. With `requireEmailVerification` above
         * (GRA-94) every new password account is verified before it can sign in, so the linking
         * ADR 0020 wanted now fires. No provider is trusted blanket (`trustedProviders`), so the
         * first condition is judged per address, not per vendor.
         */
        enabled: true,
        requireLocalEmailVerified: true,
      },
    },
    advanced: {
      /**
       * Derived from where the console and the API answer, in one place, by the rule
       * `sessionCookieAttributes` above states. `httpOnly` is unconditional either way: the
       * console never reads the cookie, only sends it.
       */
      defaultCookieAttributes: sessionCookieAttributes({
        authUrl: options.baseURL,
        ...(options.consoleUrl === undefined ? {} : { consoleUrl: options.consoleUrl }),
        corsOrigins: options.trustedOrigins ?? [],
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** A resolved session — what `auth.api.getSession` answers, null when no cookie names a live one. */
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
