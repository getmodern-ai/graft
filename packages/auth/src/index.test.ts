import type { Database } from "@graft/db";
import type { BetterAuthOptions } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";

import { createAuth } from "./index";

/**
 * The configuration, as Better Auth reads it back — no database is opened, because drizzle's pool
 * connects on the first query and nothing here queries. Sign-up, sign-in and the session resolving
 * to a person run against a real Postgres in `apps/server/src/database.integration.test.ts`; what is
 * pinned here is the shape of the account: email and password only, no verification gate for the
 * alpha, no social provider, no organization plugin (ADR 0007), and the cross-origin cookie.
 */
const auth = createAuth({
  db: drizzle("postgresql://unused@localhost:5432/unused") as unknown as Database,
  secret: "test-secret-that-is-long-enough-32-chars",
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
});

// Widened from the literal options `createAuth` passed, so an option it deliberately does not set
// can be asserted absent rather than being a type error to mention.
const options: BetterAuthOptions = auth.options;

describe("createAuth", () => {
  it("enables email and password with verification off for the alpha — the header says why", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(false);
  });

  it("registers no social provider and no plugin — a person is the account (ADR 0007)", () => {
    expect(Object.keys(options.socialProviders ?? {})).toEqual([]);
    expect(options.plugins ?? []).toEqual([]);
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

  it("answers no session for a request with no cookie", async () => {
    await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
  });
});
