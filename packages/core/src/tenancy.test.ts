import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import {
  AGENT_TOKEN_DISPLAY_LENGTH,
  AGENT_TOKEN_PREFIX,
  type AgentTokenDeps,
  bearerTokenFrom,
  hashAgentToken,
  MCP_ACCESS_TOKEN_PREFIX,
  mintAgentToken,
  mintOpaqueToken,
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

const NOW = new Date("2026-09-15T10:00:00Z");

function tokenDeps(overrides: Partial<AgentTokenDeps> = {}): AgentTokenDeps {
  return {
    findAgentByTokenHash: vi.fn(async () => ({ id: "agent_1", personId: "person_1" })),
    findAgentByMcpAccessTokenHash: vi.fn(async () => null),
    now: () => NOW,
    ...overrides,
  };
}

describe("requireAgent", () => {
  it("looks a static token up by its hash, never by the token, and answers the pair", async () => {
    const deps = tokenDeps();
    const token = mintAgentToken().token;

    await expect(requireAgent(ctx, token, deps)).resolves.toEqual({
      personId: "person_1",
      agentId: "agent_1",
    });
    expect(deps.findAgentByTokenHash).toHaveBeenCalledWith(ctx.db, hashAgentToken(token));
    expect(JSON.stringify(vi.mocked(deps.findAgentByTokenHash).mock.calls)).not.toContain(token);
    // The static prefix never reaches the OAuth read.
    expect(deps.findAgentByMcpAccessTokenHash).not.toHaveBeenCalled();
  });

  it("refuses a missing token and an unknown or revoked one with the same UNAUTHORIZED, naming the reason", async () => {
    const deps = tokenDeps({ findAgentByTokenHash: vi.fn(async () => null) });
    for (const [token, reason] of [
      [null, "token_missing"],
      [undefined, "token_missing"],
      ["", "token_missing"],
      ["grft_unknown", "token_unknown"],
    ] as const) {
      const attempt = requireAgent(ctx, token, deps);
      await expect(attempt).rejects.toThrow(ServiceError);
      await expect(attempt).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        details: { reason },
      });
    }
    // The empty cases never reach the read.
    expect(deps.findAgentByTokenHash).toHaveBeenCalledTimes(1);
  });

  /** ADR 0018: an MCP client's access token is the second shape, chosen by prefix, resolved by its own read. */
  it("looks an OAuth access token up by its hash through the OAuth read, and answers the agent it names", async () => {
    const deps = tokenDeps({
      findAgentByMcpAccessTokenHash: vi.fn(async () => ({
        agentId: "agent_oauth",
        personId: "person_1",
        expiresAt: new Date(NOW.getTime() + 60_000),
      })),
    });
    const token = mintOpaqueToken(MCP_ACCESS_TOKEN_PREFIX).value;

    await expect(requireAgent(ctx, token, deps)).resolves.toEqual({
      personId: "person_1",
      agentId: "agent_oauth",
    });
    expect(deps.findAgentByMcpAccessTokenHash).toHaveBeenCalledWith(ctx.db, hashAgentToken(token));
    expect(deps.findAgentByTokenHash).not.toHaveBeenCalled();
  });

  it("refuses an expired access token as token_expired, and an unknown or revoked one as token_unknown", async () => {
    const expired = tokenDeps({
      findAgentByMcpAccessTokenHash: vi.fn(async () => ({
        agentId: "agent_oauth",
        personId: "person_1",
        expiresAt: NOW,
      })),
    });
    await expect(
      requireAgent(ctx, mintOpaqueToken(MCP_ACCESS_TOKEN_PREFIX).value, expired),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", details: { reason: "token_expired" } });

    const unknown = tokenDeps();
    await expect(
      requireAgent(ctx, mintOpaqueToken(MCP_ACCESS_TOKEN_PREFIX).value, unknown),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", details: { reason: "token_unknown" } });
  });

  it("refuses a token under neither prefix without reading anything — it cannot be one Graft minted", async () => {
    const deps = tokenDeps();
    for (const token of ["Bearer", "grftr_a-refresh-token", "eyJhbGciOi.jwt.sig", "abc"]) {
      await expect(requireAgent(ctx, token, deps)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        details: { reason: "token_unknown" },
      });
    }
    expect(deps.findAgentByTokenHash).not.toHaveBeenCalled();
    expect(deps.findAgentByMcpAccessTokenHash).not.toHaveBeenCalled();
  });
});

describe("mintOpaqueToken", () => {
  it("mints a value under the given prefix and its SHA-256, the two prefixes never nesting", () => {
    const random = (bytes: number) => Buffer.alloc(bytes, 3);
    const access = mintOpaqueToken(MCP_ACCESS_TOKEN_PREFIX, random);
    expect(access.value).toBe(
      `${MCP_ACCESS_TOKEN_PREFIX}${Buffer.alloc(32, 3).toString("base64url")}`,
    );
    expect(access.hash).toBe(hashAgentToken(access.value));
    // `grfta_` does not start with `grft_`, so the static read is never asked about it.
    expect(access.value.startsWith(AGENT_TOKEN_PREFIX)).toBe(false);
    expect(mintOpaqueToken(MCP_ACCESS_TOKEN_PREFIX).value).not.toBe(
      mintOpaqueToken(MCP_ACCESS_TOKEN_PREFIX).value,
    );
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
