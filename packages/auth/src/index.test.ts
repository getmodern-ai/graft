import type { Database } from "@graft/db";
import type { EmailTransport, SendRequest } from "@graft/email";
import type { BetterAuthOptions } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuth, sessionCookieAttributes } from "./index";

/**
 * The configuration, as Better Auth reads it back — no database is opened, because drizzle's pool
 * connects on the first query and nothing here queries. Sign-up, sign-in and the session resolving
 * to a person run against a real Postgres in `apps/server/src/database.integration.test.ts`; what is
 * pinned here is the shape of the account: email and password only, no verification gate for the
 * registering verified first (GRA-94), a social provider only when a client is handed in (GRA-81),
 * no organization plugin (ADR 0007), and the session cookie the deployment's origins imply.
 */
const base = {
  db: drizzle("postgresql://unused@localhost:5432/unused") as unknown as Database,
  secret: "test-secret-that-is-long-enough-32-chars",
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};
const auth = createAuth(base);

// Widened from the literal options `createAuth` passed, so an option it deliberately does not set
// can be asserted absent rather than being a type error to mention.
const options: BetterAuthOptions = auth.options;

describe("createAuth", () => {
  it("enables email and password, and registering opens no session until the address is verified (GRA-94)", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(true);
  });

  it("registers no social provider by default and no plugin — a person is the account (ADR 0007)", () => {
    expect(Object.keys(options.socialProviders ?? {})).toEqual([]);
    expect(options.plugins ?? []).toEqual([]);
  });

  /**
   * A provider key present is a provider advertised, so the shape is judged by its keys: the
   * configured one alone, in the order the console draws them (GRA-81).
   */
  it("registers exactly the providers it is handed clients for", () => {
    const google = { clientId: "g-id", clientSecret: "g-secret" };
    const github = { clientId: "gh-id", clientSecret: "gh-secret" };
    const withGoogle: BetterAuthOptions = createAuth({
      ...base,
      socialProviders: { google },
    }).options;
    expect(Object.keys(withGoogle.socialProviders ?? {})).toEqual(["google"]);
    expect(withGoogle.socialProviders?.google).toEqual(google);
    const withBoth: BetterAuthOptions = createAuth({
      ...base,
      socialProviders: { google, github },
    }).options;
    expect(Object.keys(withBoth.socialProviders ?? {})).toEqual(["google", "github"]);
  });

  it("links a social sign-in to an existing account only when both addresses are verified (ADR 0020)", () => {
    expect(options.account?.accountLinking).toEqual({
      enabled: true,
      requireLocalEmailVerified: true,
    });
    expect(options.account?.accountLinking?.trustedProviders).toBeUndefined();
  });

  it("carries the console's origins as trusted, and the server's origin as its base", () => {
    expect(auth.options.trustedOrigins).toEqual(["http://localhost:3001"]);
    expect(auth.options.baseURL).toBe("http://localhost:3000");
  });

  /**
   * The rule, not a pinned value (GRA-148): `lax` for the form every self-host and Graft Cloud
   * run, one origin serving the console and the API, and `none` only where the console answers
   * somewhere else and nothing but a cross-site cookie would reach it.
   */
  describe("the session cookie follows the deployment", () => {
    it("is lax on one origin, and secure only where the scheme is https", () => {
      expect(sessionCookieAttributes({ authUrl: "https://app.getgraft.ai" })).toEqual({
        sameSite: "lax",
        secure: true,
        httpOnly: true,
      });
      expect(
        sessionCookieAttributes({
          authUrl: "http://192.168.1.5:3000",
          consoleUrl: "http://192.168.1.5:3000",
          corsOrigins: [],
        }),
      ).toEqual({ sameSite: "lax", secure: false, httpOnly: true });
    });

    it("is none and secure for a console on another origin, however it was named", () => {
      const crossSite = { sameSite: "none", secure: true, httpOnly: true };
      expect(
        sessionCookieAttributes({
          authUrl: "http://localhost:3000",
          consoleUrl: "http://localhost:3001",
        }),
      ).toEqual(crossSite);
      expect(
        sessionCookieAttributes({
          authUrl: "https://api.example.com",
          consoleUrl: "https://api.example.com",
          corsOrigins: ["https://console.example.com"],
        }),
      ).toEqual(crossSite);
    });

    it("treats an absent console URL as this origin's own", () => {
      expect(sessionCookieAttributes({ authUrl: "http://localhost:3000" })).toEqual({
        sameSite: "lax",
        secure: false,
        httpOnly: true,
      });
    });

    /** The two-port loop `base` spells: a console on :3001 in front of an API on :3000. */
    it("is what createAuth hands Better Auth", () => {
      expect(auth.options.advanced?.defaultCookieAttributes).toEqual({
        sameSite: "none",
        secure: true,
        httpOnly: true,
      });
      const sameOrigin = createAuth({
        ...base,
        trustedOrigins: [],
        consoleUrl: "https://app.getgraft.ai",
        baseURL: "https://app.getgraft.ai",
      });
      expect(sameOrigin.options.advanced?.defaultCookieAttributes).toEqual({
        sameSite: "lax",
        secure: true,
        httpOnly: true,
      });
    });
  });

  it("registers no mail hook without a transport, so a script that sends nothing builds no mail stack", () => {
    expect(options.emailAndPassword?.sendResetPassword).toBeUndefined();
    expect(options.emailAndPassword?.onExistingUserSignUp).toBeUndefined();
    expect(options.emailVerification).toBeUndefined();
  });

  /**
   * The reset link is the console's route under the console's origin — not Better Auth's own
   * callback URL, which points at the API (GRA-82). Driven through the option Better Auth reads.
   */
  describe("the reset email", () => {
    afterEach(() => vi.restoreAllMocks());

    function capture(fail = false) {
      const sent: SendRequest[] = [];
      const transport: EmailTransport = {
        name: "console",
        send: async (request) => {
          if (fail) throw new Error("mail is down");
          sent.push(request);
          return { delivered: true, transport: "console" };
        },
      };
      return { sent, transport };
    }
    const data = {
      user: {
        id: "per_1",
        email: "person@example.com",
        name: "P",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      url: "http://localhost:3000/api/auth/reset-password/tok_1?callbackURL=/",
      token: "tok_1",
    };

    it("sends the console's reset route with the token, to the account's address", async () => {
      const { sent, transport } = capture();
      const withMail = createAuth({
        ...base,
        mail: { consoleUrl: "http://localhost:3001/", transport },
      });
      await withMail.options.emailAndPassword?.sendResetPassword?.(data);
      expect(sent).toEqual([
        expect.objectContaining({
          to: "person@example.com",
          template: "passwordReset",
          actionUrl: "http://localhost:3001/reset-password?token=tok_1",
        }),
      ]);
    });

    it("logs a failed send with context and never throws — the requester is told nothing", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { transport } = capture(true);
      const withMail = createAuth({
        ...base,
        mail: { consoleUrl: "http://localhost:3001", transport },
      });
      await expect(
        withMail.options.emailAndPassword?.sendResetPassword?.(data),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toMatchObject({ personId: "per_1", transport: "console" });
      // The address is not in the log line — the context names the person by id.
      expect(JSON.stringify(error.mock.calls[0])).not.toContain("person@example.com");
    });
  });

  /** GRA-94: the two emails of a sign-up, driven through the options Better Auth reads. */
  describe("the verification and account-exists emails", () => {
    afterEach(() => vi.restoreAllMocks());

    function capture() {
      const sent: SendRequest[] = [];
      const transport: EmailTransport = {
        name: "console",
        send: async (request) => {
          sent.push(request);
          return { delivered: true, transport: "console" };
        },
      };
      return {
        sent,
        transport,
        auth: createAuth({ ...base, mail: { consoleUrl: "http://localhost:3001", transport } }),
      };
    }
    const user = {
      id: "per_1",
      email: "ada@example.com",
      name: "Ada",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("sends Better Auth's verify URL whole, with the link living a day and signing the person in", async () => {
      const { sent, auth: withMail } = capture();
      const url =
        "http://localhost:3000/api/auth/verify-email?token=tok_1&callbackURL=http%3A%2F%2Flocalhost%3A3001%2Flogin";
      await withMail.options.emailVerification?.sendVerificationEmail?.({
        user,
        url,
        token: "tok_1",
      });
      expect(sent).toEqual([
        expect.objectContaining({ to: user.email, template: "emailVerification", actionUrl: url }),
      ]);
      expect(withMail.options.emailVerification).toMatchObject({
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        expiresIn: 60 * 60 * 24,
      });
    });

    it("answers a taken address with the account-exists email to the console's login door, pre-filled", async () => {
      const { sent, auth: withMail } = capture();
      await withMail.options.emailAndPassword?.onExistingUserSignUp?.({ user });
      expect(sent).toEqual([
        expect.objectContaining({
          to: user.email,
          template: "accountExists",
          actionUrl: "http://localhost:3001/login?email=ada%40example.com",
        }),
      ]);
    });

    it("logs an undelivered verification with the person's id and never throws", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const transport: EmailTransport = {
        name: "smtp",
        send: async () => ({ delivered: false, transport: "smtp" }),
      };
      const withMail = createAuth({
        ...base,
        mail: { consoleUrl: "http://localhost:3001", transport },
      });
      await expect(
        withMail.options.emailVerification?.sendVerificationEmail?.({
          user,
          url: "http://localhost:3000/api/auth/verify-email?token=t",
          token: "t",
        }),
      ).resolves.toBeUndefined();
      expect(error.mock.calls[0]?.[1]).toMatchObject({ personId: "per_1", transport: "smtp" });
      expect(JSON.stringify(error.mock.calls[0])).not.toContain("ada@example.com");
    });
  });

  it("answers no session for a request with no cookie", async () => {
    await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
  });
});
