import { checkModule, type ModuleCheck } from "@graft/check";
import {
  type AgentDeps,
  type ConnectionDeps,
  defaultAgentDeps,
  defaultLedgerDeps,
  defaultToolDeps,
  defaultWorkingSetDeps,
  type LedgerDeps,
  type ToolDeps,
  type WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import { loadSkills, type RunnerFile, runnerFiles, type Skill } from "@graft/runner";
import type { SandboxBackend, SandboxFile } from "@graft/sandbox";
import type { CapabilityTokenKeys } from "@graft/token";

import { type ReadWebPage, readWebPage } from "./web-page";

/**
 * Everything the MCP server is handed rather than owns — the one object `apps/server` builds from
 * its environment and every later ticket extends: GRA-23 adds the approval reads, GRA-29 the
 * `acquire` job engine and the model adapter, GRA-18 the toolbox store and the publish. A test
 * binds the same shape to in-memory fakes (`./testing/fake-deps.ts`) and the fake sandbox, so the
 * suite in `server.test.ts` runs with no database, no Docker and no network beyond a loopback
 * listener for the proxy.
 *
 * The five service `*Deps` are `@graft/core`'s own test seams, passed through as they are: the MCP
 * server calls the services (ADR 0011: the core is the API, the transports are thin), and a service
 * takes its deps as a required argument for the reason its header gives.
 */

/**
 * A read of the person's toolbox by path — the store GRA-18 builds satisfies it. Optional here
 * because a run never reads through it (the sandbox sees the mounted volume, ADR 0002's seam);
 * `read_tool_source` prefers it when present and falls back to the sandbox when not.
 */
export type ToolboxReader = {
  readTree(toolboxId: string, path: string): Promise<SandboxFile[]>;
};

/** What `publish_tool` hands GRA-18's publish, once it exists; until then the tool answers `not_available_yet`. */
export type PublishToolArgs = {
  personId: string;
  agentId: string;
  vendor: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The module on the agent's sandbox, resolved. */
  sourcePath: string;
  files: SandboxFile[];
  testInput: Record<string, unknown> | null;
  connectionId: string | null;
};

export type PublishTool = (args: PublishToolArgs) => Promise<Record<string, unknown>>;

export type McpDeps = {
  db: DbOrTx;
  agent: AgentDeps;
  connection: ConnectionDeps;
  tool: ToolDeps;
  workingSet: WorkingSetDeps;
  ledger: LedgerDeps;
  /** The seam (ADR 0002): Docker in this repository, the hosted backing privately, the fake in tests. */
  sandbox: SandboxBackend;
  /** An agent's sandbox is `<prefix>-<agentId>`; the backing adds its own prefix in front. */
  sandboxNamePrefix?: string;
  /** The deployment's key pair, or null: every run then refuses `proxy_unconfigured` before touching a sandbox. */
  keys: CapabilityTokenKeys | null;
  /** What a sandbox is handed as `GRAFT_PROXY_URL` (ADR 0010) — `GRAFT_PROXY_PUBLIC_URL`. */
  proxyPublicUrl: string;
  checkModule: ModuleCheck;
  runnerFiles: () => Promise<RunnerFile[]>;
  skills: () => Promise<Skill[]>;
  readWebPage: ReadWebPage;
  toolbox?: ToolboxReader | null;
  publishTool?: PublishTool | null;
  /** The `tools/list_changed` rate limit's window (`notifier.ts`); a test sets it low. */
  listChangedWindowMs?: number;
  now?: () => Date;
};

export type CreateMcpDepsInput = Pick<
  McpDeps,
  "db" | "connection" | "sandbox" | "keys" | "proxyPublicUrl"
> &
  Partial<Omit<McpDeps, "db" | "connection" | "sandbox" | "keys" | "proxyPublicUrl">>;

/**
 * The real deps, given what only the server knows: the database handle, the connection deps (which
 * carry the vault's encrypt half), the sandbox backing the environment selected, the key pair and
 * the proxy's public URL. Everything else has one default — the core's `default*Deps`, the check,
 * the runner and skills shipped with `@graft/runner`, the page reader — and may be overridden.
 */
export function createMcpDeps(input: CreateMcpDepsInput): McpDeps {
  return {
    agent: defaultAgentDeps,
    tool: defaultToolDeps,
    workingSet: defaultWorkingSetDeps,
    ledger: defaultLedgerDeps,
    checkModule,
    runnerFiles,
    skills: loadSkills,
    readWebPage: (args) => readWebPage(args),
    ...input,
  };
}
