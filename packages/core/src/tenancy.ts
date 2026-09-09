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
 * The read `requireAgent` needs, declared structurally so nothing here binds a repo function —
 * `@graft/db/repo/agent`'s `findAgentByTokenHash` satisfies it exactly, and answers null for a
 * revoked agent in the statement, so a revoked token cannot reach this function as a row.
 */
export type AgentTokenDeps = {
  findAgentByTokenHash: (
    db: DbOrTx,
    tokenHash: string,
  ) => Promise<{ id: string; personId: string } | null>;
};

/**
 * The MCP server's door: a bearer token resolves to its agent and to no other, and a revoked or
 * unknown token is one refusal — telling them apart would confirm a token once existed. `deps` is
 * required rather than defaulted: a defaulted dep would let a caller skip the read by omitting it,
 * and omission is exactly the failure this function exists to prevent.
 */
export async function requireAgent(
  ctx: ServiceContext,
  token: string | null | undefined,
  deps: AgentTokenDeps,
): Promise<AgentScope> {
  if (!token) throw new ServiceError("UNAUTHORIZED", "This request carries no agent token");
  const row = await deps.findAgentByTokenHash(ctx.db, hashAgentToken(token));
  if (!row) throw new ServiceError("UNAUTHORIZED", "This agent token is unknown or revoked");
  return { personId: row.personId, agentId: row.id };
}

/** Marks a Graft agent token in a config file or a log, so a leaked one is recognisable as ours. */
export const AGENT_TOKEN_PREFIX = "grft_";

/** How much of a token the console shows — enough to tell two apart, not enough to guess one. */
export const AGENT_TOKEN_DISPLAY_LENGTH = 8;

/** 256 bits of entropy, base64url — a token is never derivable from its hash by search. */
const AGENT_TOKEN_RANDOM_BYTES = 32;

/**
 * The stored form of a token. Plain SHA-256, unsalted and unkeyed, and that is enough: the token
 * is 256 random bits, not a password, so there is nothing for a rainbow table to find, and a keyed
 * hash would make the lookup depend on a secret the database read does not otherwise need.
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
