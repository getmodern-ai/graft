import {
  consumeMcpAuthorizationCode,
  findAgentByMcpAccessTokenHash,
  findMcpAuthorizationCodeByHash,
  findMcpClient,
  findMcpRefreshTokenByHash,
  findMcpTokenByHash,
  insertMcpAuthorizationCode,
  insertMcpClient,
  insertMcpToken,
  pruneMcpExpired,
  revokeMcpGrant,
  revokeMcpToken,
  rotateMcpToken,
  setMcpTokenRotationReplay,
} from "@graft/db/repo/mcp-oauth";

/**
 * The authorization server's test seam (ADR 0018): the repositories, the clock, the id source and
 * the entropy. `defaultMcpOAuthDeps` binds the real ones; `mcp-oauth.service.test.ts` passes maps
 * and a fixed clock and never touches a database. The only file of the module that imports a repo
 * *function* — the service imports types.
 */
export type McpOAuthDeps = {
  insertMcpClient: typeof insertMcpClient;
  findMcpClient: typeof findMcpClient;
  insertMcpAuthorizationCode: typeof insertMcpAuthorizationCode;
  findMcpAuthorizationCodeByHash: typeof findMcpAuthorizationCodeByHash;
  consumeMcpAuthorizationCode: typeof consumeMcpAuthorizationCode;
  insertMcpToken: typeof insertMcpToken;
  findMcpTokenByHash: typeof findMcpTokenByHash;
  findMcpRefreshTokenByHash: typeof findMcpRefreshTokenByHash;
  findAgentByMcpAccessTokenHash: typeof findAgentByMcpAccessTokenHash;
  rotateMcpToken: typeof rotateMcpToken;
  /** The rotation's winner seals the successor on the retired row (`mcp-oauth.replay.ts`). */
  setMcpTokenRotationReplay: typeof setMcpTokenRotationReplay;
  revokeMcpToken: typeof revokeMcpToken;
  revokeMcpGrant: typeof revokeMcpGrant;
  pruneMcpExpired: typeof pruneMcpExpired;
  newId: () => string;
  now: () => Date;
  /** The entropy behind every code, token, secret and seal nonce — injectable so a test knows the values. */
  randomBytes?: (bytes: number) => Buffer;
};

export const defaultMcpOAuthDeps: McpOAuthDeps = {
  insertMcpClient,
  findMcpClient,
  insertMcpAuthorizationCode,
  findMcpAuthorizationCodeByHash,
  consumeMcpAuthorizationCode,
  insertMcpToken,
  findMcpTokenByHash,
  findMcpRefreshTokenByHash,
  findAgentByMcpAccessTokenHash,
  rotateMcpToken,
  setMcpTokenRotationReplay,
  revokeMcpToken,
  revokeMcpGrant,
  pruneMcpExpired,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
