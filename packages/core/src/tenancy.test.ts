import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import {
  AGENT_TOKEN_DISPLAY_LENGTH,
  AGENT_TOKEN_PREFIX,
  bearerTokenFrom,
  hashAgentToken,
  mintAgentToken,
  requireAgent,
  requirePerson,
} from "./tenancy";

/** The two doors (ADR 0007), with no database: `db` is never dereferenced because the fake ignores it. */
const ctx = { db: {} } as unknown as ServiceContext;

describe("requirePerson", () => {
  it("answers the person behind a session", () => {
    expect(requirePerson({ user: { id: "person_1" } })).toEqual({ personId: "person_1" });
  });

  it("refuses no session, and a session with no person, as UNAUTHORIZED", () => {
    for (const session of [null, undefined, { user: { id: "" } }]) {
      expect(() => requirePerson(session)).toThrow(ServiceError);
      try {
        requirePerson(session);
      } catch (error) {
        expect((error as ServiceError).code).toBe("UNAUTHORIZED");
        expect((error as ServiceError).status).toBe(401);
      }
    }
  });
});

describe("mintAgentToken", () => {
  it("mints a prefixed token, its SHA-256, and the first characters for display", () => {
    const random = (bytes: number) => Buffer.alloc(bytes, 7);
    const minted = mintAgentToken(random);

    expect(minted.token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(minted.token).toBe(`${AGENT_TOKEN_PREFIX}${Buffer.alloc(32, 7).toString("base64url")}`);
    expect(minted.tokenHash).toBe(createHash("sha256").update(minted.token).digest("hex"));
    expect(minted.tokenPrefix).toBe(minted.token.slice(0, AGENT_TOKEN_DISPLAY_LENGTH));
    expect(minted.tokenHash).not.toContain(minted.token.slice(AGENT_TOKEN_PREFIX.length));
  });

  it("mints a different token each time by default", () => {
    expect(mintAgentToken().token).not.toBe(mintAgentToken().token);
  });
});

describe("requireAgent", () => {
  it("looks the token up by its hash, never by the token, and answers the pair", async () => {
    const findAgentByTokenHash = vi.fn(async () => ({ id: "agent_1", personId: "person_1" }));
    const token = mintAgentToken().token;

    await expect(requireAgent(ctx, token, { findAgentByTokenHash })).resolves.toEqual({
      personId: "person_1",
      agentId: "agent_1",
    });
    expect(findAgentByTokenHash).toHaveBeenCalledWith(ctx.db, hashAgentToken(token));
    expect(JSON.stringify(findAgentByTokenHash.mock.calls)).not.toContain(token);
  });

  it("refuses a missing token and an unknown or revoked one with the same UNAUTHORIZED", async () => {
    const findAgentByTokenHash = vi.fn(async () => null);
    for (const token of [null, undefined, "", "grft_unknown"]) {
      const attempt = requireAgent(ctx, token, { findAgentByTokenHash });
      await expect(attempt).rejects.toThrow(ServiceError);
      await expect(attempt).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    // The empty cases never reach the read.
    expect(findAgentByTokenHash).toHaveBeenCalledTimes(1);
  });
});

describe("bearerTokenFrom", () => {
  it("reads a bearer token from the Authorization header, case-insensitively", () => {
    expect(bearerTokenFrom(new Headers({ authorization: "Bearer grft_abc" }))).toBe("grft_abc");
    expect(bearerTokenFrom(new Headers({ Authorization: "bearer grft_abc" }))).toBe("grft_abc");
  });

  it("answers null for no header or another scheme", () => {
    expect(bearerTokenFrom(new Headers())).toBeNull();
    expect(bearerTokenFrom(new Headers({ authorization: "Basic abc" }))).toBeNull();
    expect(bearerTokenFrom(new Headers({ authorization: "Bearer" }))).toBeNull();
  });
});
