import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import {
  mcpAuthorizationCode,
  mcpClient,
  mcpToken,
  type NewMcpAuthorizationCode,
  type NewMcpClient,
  type NewMcpToken,
} from "../schema/mcp-oauth";
import type { AgentScope } from "./scope";

/**
 * Query ownership for Graft's authorization server (ADR 0018): client registrations, authorization
 * codes and the two kinds of token. Three of the reads here are **unscoped by nature**, like the
 * agent token's in `repo/agent.ts`, and each says why: a client is nobody's until a consent binds
 * it, and a code or a token is looked up by the hash of the value the caller presented, which is
 * the whole of the caller's identity at that moment. Every read that resolves a token to an agent
 * joins `agent.revoked_at IS NULL` in the statement, so a revoked agent's tokens answer nothing
 * and the service never holds a revoked row it might forget to check.
 */

export type McpClientRow = typeof mcpClient.$inferSelect;
export type McpAuthorizationCodeRow = typeof mcpAuthorizationCode.$inferSelect;
export type McpTokenRow = typeof mcpToken.$inferSelect;

export async function insertMcpClient(db: DbOrTx, input: NewMcpClient): Promise<McpClientRow> {
  const [row] = await db.insert(mcpClient).values(input).returning();
  if (!row) throw new Error("Insert of mcp_client returned no row");
  return row;
}

/** A registration by its `client_id` — unscoped: the id is what the client presents, and the row is nobody's. */
export async function findMcpClient(db: DbOrTx, clientId: string): Promise<McpClientRow | null> {
  const [row] = await db.select().from(mcpClient).where(eq(mcpClient.id, clientId)).limit(1);
  return row ?? null;
}

export async function insertMcpAuthorizationCode(
  db: DbOrTx,
  input: NewMcpAuthorizationCode,
): Promise<McpAuthorizationCodeRow> {
  const [row] = await db.insert(mcpAuthorizationCode).values(input).returning();
  if (!row) throw new Error("Insert of mcp_authorization_code returned no row");
  return row;
}

/** What the token endpoint needs of a code: the row, and whether the agent it is bound to still stands. */
export type McpAuthorizationCodeGrant = McpAuthorizationCodeRow & { agentRevokedAt: Date | null };

/**
 * A code by the hash of the value presented — unscoped by nature; the service checks the rest. The
 * agent's `revoked_at` rides beside it, carried rather than filtered as the refresh read does, so
 * a code bound to an agent revoked between the consent and the exchange is refused before a token
 * that could never resolve is minted.
 */
export async function findMcpAuthorizationCodeByHash(
  db: DbOrTx,
  codeHash: string,
): Promise<McpAuthorizationCodeGrant | null> {
  const [row] = await db
    .select({ code: mcpAuthorizationCode, agentRevokedAt: agent.revokedAt })
    .from(mcpAuthorizationCode)
    .innerJoin(agent, eq(agent.id, mcpAuthorizationCode.agentId))
    .where(eq(mcpAuthorizationCode.codeHash, codeHash))
    .limit(1);
  return row ? { ...row.code, agentRevokedAt: row.agentRevokedAt } : null;
}

/**
 * Spend a code. `consumed_at IS NULL` in the predicate is what makes a second exchange match
 * nothing, in the statement rather than in a check the service could race past.
 */
export async function consumeMcpAuthorizationCode(
  db: DbOrTx,
  codeId: string,
  at: Date,
): Promise<McpAuthorizationCodeRow | null> {
  const [row] = await db
    .update(mcpAuthorizationCode)
    .set({ consumedAt: at })
    .where(and(eq(mcpAuthorizationCode.id, codeId), isNull(mcpAuthorizationCode.consumedAt)))
    .returning();
  return row ?? null;
}

export async function insertMcpToken(db: DbOrTx, input: NewMcpToken): Promise<McpTokenRow> {
  const [row] = await db.insert(mcpToken).values(input).returning();
  if (!row) throw new Error("Insert of mcp_token returned no row");
  return row;
}

/** A token of either kind by the hash presented — unscoped by nature; what the revocation endpoint reads. */
export async function findMcpTokenByHash(
  db: DbOrTx,
  tokenHash: string,
): Promise<McpTokenRow | null> {
  const [row] = await db.select().from(mcpToken).where(eq(mcpToken.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

/** What the MCP door needs of an access token: the agent it names, and the token's own clocks. */
export type McpAccessTokenAgent = {
  tokenId: string;
  agentId: string;
  personId: string;
  clientId: string;
  expiresAt: Date | null;
};

/**
 * The MCP door's read (ADR 0018): an unrevoked access token by its hash, joined to an unrevoked
 * agent — both conditions in the statement, so a revoked agent's token and an unknown token are one
 * refusal, exactly as `findAgentByTokenHash` treats a static token. Expiry is left to the service,
 * which tells an expired token apart from an unknown one because the holder of an expired token had
 * it legitimately and is told to refresh.
 */
export async function findAgentByMcpAccessTokenHash(
  db: DbOrTx,
  tokenHash: string,
): Promise<McpAccessTokenAgent | null> {
  const [row] = await db
    .select({
      tokenId: mcpToken.id,
      agentId: agent.id,
      personId: agent.personId,
      clientId: mcpToken.clientId,
      expiresAt: mcpToken.expiresAt,
    })
    .from(mcpToken)
    .innerJoin(agent, eq(agent.id, mcpToken.agentId))
    .where(
      and(
        eq(mcpToken.tokenHash, tokenHash),
        eq(mcpToken.kind, "access"),
        isNull(mcpToken.revokedAt),
        isNull(agent.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What the token endpoint needs of a refresh token: the row, and whether its agent still stands. */
export type McpRefreshTokenGrant = McpTokenRow & { agentRevokedAt: Date | null };

/**
 * The token endpoint's read of a refresh token by its hash, with the agent's `revoked_at` beside
 * it — carried rather than filtered, because the service answers the same `invalid_grant` for a
 * revoked agent and for a replayed token but must revoke the grant only for the latter.
 */
export async function findMcpRefreshTokenByHash(
  db: DbOrTx,
  tokenHash: string,
): Promise<McpRefreshTokenGrant | null> {
  const [row] = await db
    .select({ token: mcpToken, agentRevokedAt: agent.revokedAt })
    .from(mcpToken)
    .innerJoin(agent, eq(agent.id, mcpToken.agentId))
    .where(and(eq(mcpToken.tokenHash, tokenHash), eq(mcpToken.kind, "refresh")))
    .limit(1);
  return row ? { ...row.token, agentRevokedAt: row.agentRevokedAt } : null;
}

/**
 * Claim a refresh token for rotation. `rotated_at IS NULL` in the predicate makes this a race two
 * refreshes cannot both win: the statement answers the row to exactly one caller and null to the
 * other, in the statement, so only the winner mints a successor and the first stamp stands.
 */
export async function rotateMcpToken(
  db: DbOrTx,
  tokenId: string,
  at: Date,
): Promise<McpTokenRow | null> {
  const [row] = await db
    .update(mcpToken)
    .set({ rotatedAt: at })
    .where(and(eq(mcpToken.id, tokenId), isNull(mcpToken.rotatedAt)))
    .returning();
  return row ?? null;
}

/** Store the sealed successor on a retired refresh token — what the rotation's winner writes beside its claim. */
export async function setMcpTokenRotationReplay(
  db: DbOrTx,
  tokenId: string,
  sealed: string,
): Promise<void> {
  await db.update(mcpToken).set({ rotationReplay: sealed }).where(eq(mcpToken.id, tokenId));
}

/** Revoke one token — an access token presented at the revocation endpoint (RFC 7009). */
export async function revokeMcpToken(db: DbOrTx, tokenId: string, at: Date): Promise<void> {
  await db
    .update(mcpToken)
    .set({ revokedAt: at })
    .where(and(eq(mcpToken.id, tokenId), isNull(mcpToken.revokedAt)));
}

/**
 * Revoke every token of a grant — a refresh token revoked at the endpoint takes its access tokens
 * with it (RFC 7009 §2.1), and a rotated refresh token presented again past the grace window is a
 * replay that ends the grant (OAuth 2.1 §4.3.1).
 */
export async function revokeMcpGrant(db: DbOrTx, grantId: string, at: Date): Promise<number> {
  const rows = await db
    .update(mcpToken)
    .set({ revokedAt: at })
    .where(and(eq(mcpToken.grantId, grantId), isNull(mcpToken.revokedAt)))
    .returning({ id: mcpToken.id });
  return rows.length;
}

/**
 * Revoke every token an agent's clients hold, under the scope pair — what revoking the agent does
 * beside stamping the agent row (ADR 0018: the agent's revocation is the grant's). The resolving
 * reads already refuse a revoked agent's tokens in their join; this makes the token rows say so too.
 */
export async function revokeMcpTokensForAgent(
  db: DbOrTx,
  scope: AgentScope,
  at: Date,
): Promise<number> {
  const rows = await db
    .update(mcpToken)
    .set({ revokedAt: at })
    .where(
      and(
        inArray(
          mcpToken.agentId,
          db
            .select({ id: agent.id })
            .from(agent)
            .where(and(eq(agent.id, scope.agentId), eq(agent.personId, scope.personId))),
        ),
        isNull(mcpToken.revokedAt),
      ),
    )
    .returning({ id: mcpToken.id });
  return rows.length;
}

/**
 * Housekeeping the token endpoint does on the way past: access tokens dead for longer than a day,
 * and codes expired as long, are deleted — nobody can present them, and the ledger of what an
 * agent did is `usage_ledger`, not this table. Refresh tokens are kept whatever their state; a
 * revoked or rotated one is the record of the grant.
 */
export async function pruneMcpExpired(db: DbOrTx, before: Date): Promise<void> {
  await db.delete(mcpToken).where(and(eq(mcpToken.kind, "access"), lt(mcpToken.expiresAt, before)));
  await db.delete(mcpAuthorizationCode).where(lt(mcpAuthorizationCode.expiresAt, before));
  // A seal is for the grace window; long past it, the retired row keeps its record and nothing else.
  await db
    .update(mcpToken)
    .set({ rotationReplay: null })
    .where(and(lt(mcpToken.rotatedAt, before), isNotNull(mcpToken.rotationReplay)));
}
