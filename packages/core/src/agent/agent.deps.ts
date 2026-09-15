import {
  findAgent,
  findAgentByTokenHash,
  insertAgent,
  listAgentConnectionIds,
  listAgents,
  listAllActiveAgents,
  replaceAgentConnections,
  revokeAgent,
  setAgentConnectedVia,
  updateAgent,
} from "@graft/db/repo/agent";
import { findConnectionsByIds } from "@graft/db/repo/connection";
import { findAgentByMcpAccessTokenHash, revokeMcpTokensForAgent } from "@graft/db/repo/mcp-oauth";

/**
 * The agent module's test seam: the repositories it reads and writes, the clock and the id source.
 * `defaultAgentDeps` binds the real ones; a test passes fakes and never touches a database. The
 * only file of the module that imports a repo *function* — the service imports types.
 */
export type AgentDeps = {
  insertAgent: typeof insertAgent;
  findAgent: typeof findAgent;
  findAgentByTokenHash: typeof findAgentByTokenHash;
  /** The MCP door's second read (ADR 0018): an OAuth access token to its agent, revoked ones filtered in the statement. */
  findAgentByMcpAccessTokenHash: typeof findAgentByMcpAccessTokenHash;
  listAgents: typeof listAgents;
  updateAgent: typeof updateAgent;
  revokeAgent: typeof revokeAgent;
  /** Revoking an agent revokes every token an MCP client holds for it (ADR 0018), in the same transaction. */
  revokeMcpTokensForAgent: typeof revokeMcpTokensForAgent;
  /** The consent naming an existing agent records which client it was connected from (ADR 0018). */
  setAgentConnectedVia: typeof setAgentConnectedVia;
  replaceAgentConnections: typeof replaceAgentConnections;
  listAgentConnectionIds: typeof listAgentConnectionIds;
  /** Setting a scope reads the person's connections to refuse an id that is not theirs. */
  findConnectionsByIds: typeof findConnectionsByIds;
  /** The sweep's roster — the one read here with no person in it (ADR 0009; `listActiveAgentScopes`). */
  listAllActiveAgents: typeof listAllActiveAgents;
  newId: () => string;
  now: () => Date;
  /** The token's entropy — injectable so a test knows the token it will be shown. */
  randomBytes?: (bytes: number) => Buffer;
};

export const defaultAgentDeps: AgentDeps = {
  insertAgent,
  findAgent,
  findAgentByTokenHash,
  findAgentByMcpAccessTokenHash,
  listAgents,
  updateAgent,
  revokeAgent,
  revokeMcpTokensForAgent,
  setAgentConnectedVia,
  replaceAgentConnections,
  listAgentConnectionIds,
  findConnectionsByIds,
  listAllActiveAgents,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
