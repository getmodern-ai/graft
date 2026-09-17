import type { Database } from "@graft/db";
import type { EmailTransport, SendRequest } from "@graft/email";
import type { BetterAuthOptions } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "./index";

/**
 * The configuration, as Better Auth reads it back — no database is opened, because drizzle's pool
 * connects on the first query and nothing here queries. Sign-up, sign-in and the session resolving
 * to a person run against a real Postgres in `apps/server/src/database.integration.test.ts`; what is
 * pinned here is the shape of the account: email and password only, no verification gate for the
 * alpha, a social provider only when a client is handed in (GRA-81), no organization plugin
 * (ADR 0007), and the cross-origin cookie.
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
  it("enables email and password with verification off for the alpha — the header says why", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(false);
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

  it("sets the session cookie for a cross-origin console", () => {
    expect(auth.options.advanced?.defaultCookieAttributes).toEqual({
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  });

  it("sets no reset hook without a transport, so a script that never resets builds no mail stack", () => {
    expect(options.emailAndPassword?.sendResetPassword).toBeUndefined();
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
        passwordReset: { consoleUrl: "http://localhost:3001/", transport },
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
        passwordReset: { consoleUrl: "http://localhost:3001", transport },
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

  it("answers no session for a request with no cookie", async () => {
    await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
  });
});
