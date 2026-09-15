import { createHash, randomBytes } from "node:crypto";

import type { DbOrTx } from "@graft/db";
import type { AgentScope } from "@graft/db/repo/scope";

import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * Resolving who a request belongs to (ADR 0007): a **person**, from a Better Auth session, or an
 * **agent**, from the bearer token the harness carries in its MCP `headers` block. These are the
 * only two ways in, and each is one function, so there is one definition of "whose request is this"
 * — the value every scoped query depends on, where a second, subtly different reading is the kind
 * of bug that leaks data rather than throwing.
 *
 * An agent's bearer token comes in two shapes since ADR 0018, told apart by prefix: the static
 * `grft_` token a person copied into a harness's config, and the `grfta_` access token an MCP
 * client holds after an OAuth consent. Both resolve to exactly one agent through `requireAgent`,
 * and nothing downstream knows which shape arrived.
 *
 * `AgentScope` is re-exported from `@graft/db/repo/scope` rather than declared again, so the shape
 * `requireAgent` produces and the shape every scoped repo function consumes cannot drift.
 */

export type { AgentScope };

/** Who is signed in — the person, and nothing resolved beyond that. */
export type Principal = { personId: string };

/** The part of a Better Auth session this file reads; the rest is the transport's business. */
export type SessionLike = { user: { id: string } } | null | undefined;

/** The console's door: a session, or `UNAUTHORIZED`. */
export function requirePerson(session: SessionLike): Principal {
  const personId = session?.user?.id;
  if (!personId) throw new ServiceError("UNAUTHORIZED", "Sign in to continue");
  return { personId };
}

/**
 * The reads `requireAgent` needs, declared structurally so nothing here binds a repo function —
 * `@graft/db/repo/agent`'s `findAgentByTokenHash` and `@graft/db/repo/mcp-oauth`'s
 * `findAgentByMcpAccessTokenHash` satisfy them exactly, and each answers null for a revoked agent
 * in the statement, so a revoked token cannot reach this function as a row. The clock is for the
 * access token's expiry, which the read carries rather than filters (ADR 0018).
 */
export type AgentTokenDeps = {
  findAgentByTokenHash: (
    db: DbOrTx,
    tokenHash: string,
  ) => Promise<{ id: string; personId: string } | null>;
  findAgentByMcpAccessTokenHash: (
    db: DbOrTx,
    tokenHash: string,
  ) => Promise<{ agentId: string; personId: string; expiresAt: Date | null } | null>;
  now: () => Date;
};

/**
 * Why an agent token was refused — the word the MCP door puts in its body and its
 * `WWW-Authenticate` challenge (`@graft/mcp`'s `http.ts`). `token_expired` is the one that tells
 * the holder anything, and it tells them only what they already knew: the token they were issued
 * has run out and the refresh token is the way back.
 */
export type AgentTokenRefusal = "token_missing" | "token_unknown" | "token_expired";

function refuse(reason: AgentTokenRefusal, message: string): ServiceError {
  return new ServiceError("UNAUTHORIZED", message, { details: { reason } });
}

/**
 * The MCP server's door: a bearer token resolves to its agent and to no other, and a revoked or
 * unknown token is one refusal — telling them apart would confirm a token once existed. `deps` is
 * required rather than defaulted: a defaulted dep would let a caller skip the read by omitting it,
 * and omission is exactly the failure this function exists to prevent.
 *
 * The prefix chooses the read. A token with neither prefix is refused without a database round
 * trip: it cannot be one Graft minted.
 */
export async function requireAgent(
  ctx: ServiceContext,
  token: string | null | undefined,
  deps: AgentTokenDeps,
): Promise<AgentScope> {
  if (!token) throw refuse("token_missing", "This request carries no agent token");
  if (token.startsWith(AGENT_TOKEN_PREFIX)) {
    const row = await deps.findAgentByTokenHash(ctx.db, hashAgentToken(token));
    if (!row) throw refuse("token_unknown", "This agent token is unknown or revoked");
    return { personId: row.personId, agentId: row.id };
  }
  if (token.startsWith(MCP_ACCESS_TOKEN_PREFIX)) {
    const row = await deps.findAgentByMcpAccessTokenHash(ctx.db, hashAgentToken(token));
    if (!row) throw refuse("token_unknown", "This access token is unknown or revoked");
    if (row.expiresAt && row.expiresAt.getTime() <= deps.now().getTime()) {
      throw refuse("token_expired", "This access token has expired — refresh it");
    }
    return { personId: row.personId, agentId: row.agentId };
  }
  throw refuse("token_unknown", "This agent token is unknown or revoked");
}

/** Marks a Graft agent token in a config file or a log, so a leaked one is recognisable as ours. */
export const AGENT_TOKEN_PREFIX = "grft_";

/**
 * The four opaque values Graft's authorization server mints (ADR 0018), each with a prefix of its
 * own so a leaked value is recognisable for what it is and so the MCP door can choose its read
 * without touching the database. None shares `grft_`'s exact prefix — `grfta_` does not start with
 * `grft_` — so the two lookups can never be asked about each other's tokens.
 */
export const MCP_ACCESS_TOKEN_PREFIX = "grfta_";
export const MCP_REFRESH_TOKEN_PREFIX = "grftr_";
export const MCP_AUTHORIZATION_CODE_PREFIX = "grftc_";
export const MCP_CLIENT_SECRET_PREFIX = "grfts_";

/** How much of a token the console shows — enough to tell two apart, not enough to guess one. */
export const AGENT_TOKEN_DISPLAY_LENGTH = 8;

/** 256 bits of entropy, base64url — a token is never derivable from its hash by search. */
const AGENT_TOKEN_RANDOM_BYTES = 32;

/**
 * The stored form of a token. Plain SHA-256, unsalted and unkeyed, and that is enough: the token
 * is 256 random bits, not a password, so there is nothing for a rainbow table to find, and a keyed
 * hash would make the lookup depend on a secret the database read does not otherwise need. The
 * authorization server's codes, tokens and client secrets are hashed the same way, for the same
 * reason.
 */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type MintedAgentToken = {
  /** Shown once, at creation, and never stored. */
  token: string;
  tokenHash: string;
  tokenPrefix: string;
};

/** A fresh token and both of its stored forms. `random` is injectable so a test's token is known. */
export function mintAgentToken(random: (bytes: number) => Buffer = randomBytes): MintedAgentToken {
  const token = `${AGENT_TOKEN_PREFIX}${random(AGENT_TOKEN_RANDOM_BYTES).toString("base64url")}`;
  return {
    token,
    tokenHash: hashAgentToken(token),
    tokenPrefix: token.slice(0, AGENT_TOKEN_DISPLAY_LENGTH),
  };
}

/** An opaque value and its stored hash — the authorization server's codes, tokens and secrets. */
export type OpaqueToken = { value: string; hash: string };

/** A fresh opaque value under one of the prefixes above; `random` is injectable as for `mintAgentToken`. */
export function mintOpaqueToken(
  prefix: string,
  random: (bytes: number) => Buffer = randomBytes,
): OpaqueToken {
  const value = `${prefix}${random(AGENT_TOKEN_RANDOM_BYTES).toString("base64url")}`;
  return { value, hash: hashAgentToken(value) };
}

/**
 * The token out of a request: `Authorization: Bearer <token>`, which is what a harness's MCP
 * `headers` block carries (ADR 0007). Null for no header or another shape; the caller refuses.
 */
export function bearerTokenFrom(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
