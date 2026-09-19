import { readAskCardHtml } from "@graft/ask-card";
import { checkModule, type ModuleCheck } from "@graft/check";
import {
  type AcquireJobDeps,
  type AgentDeps,
  type ApprovalDeps,
  type ConnectionDeps,
  defaultAcquireJobDeps,
  defaultAgentDeps,
  defaultApprovalDeps,
  defaultLedgerDeps,
  defaultPendingActionDeps,
  defaultToolDeps,
  defaultWorkingSetDeps,
  type LedgerDeps,
  type PendingActionDeps,
  type ToolDeps,
  type WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import { findMcpClient } from "@graft/db/repo/mcp-oauth";
import { listPendingActionsByKind, lockPendingActionKey } from "@graft/db/repo/pending-action";
import type { ModelAdapter } from "@graft/model";
import {
  type PublishArgs,
  type PublishDeps,
  type PublishOutcome,
  publishToolVersion,
} from "@graft/publish";
import { loadSkills, type RunnerFile, runnerFiles, type Skill } from "@graft/runner";
import type { SandboxBackend } from "@graft/sandbox";
import type { CapabilityTokenKeys } from "@graft/token";
import type { ToolboxStore } from "@graft/toolbox";

import type { AcquireConfig } from "./acquire/shapes";
import type { HandoffConfig } from "./handoff";
import { createInFlightRegistry, type InFlightRegistry } from "./in-flight";
import { createToolListChangedNotifier, type ToolListChangedNotifier } from "./notifier";
import { type ReadWebPage, readWebPage } from "./web-page";

/**
 * Everything the MCP server is handed rather than owns — the one object `apps/server` builds from
 * its environment and every later ticket extends: GRA-23 added the approval reads, GRA-24 the
 * notifier and the in-flight registry the sweep shares with the endpoint, GRA-29 the `acquire`
 * job's record, the model adapter and the runner's kick, at the end. A test binds the same
 * shape to in-memory fakes (`./testing/fake-deps.ts`) and the fake sandbox, so the suite in
 * `server.test.ts` runs with no database, no Docker and no network beyond a loopback listener for
 * the proxy.
 *
 * The five service `*Deps` are `@graft/core`'s own test seams, passed through as they are: the MCP
 * server calls the services (ADR 0011: the core is the API, the transports are thin), and a service
 * takes its deps as a required argument for the reason its header gives.
 */

/**
 * The one read of the toolbox the MCP server makes through the store rather than through a sandbox
 * — `read_tool_source`, which has no reason to provision one. A run never reads through it: the
 * sandbox sees the mounted volume (ADR 0002's seam), and `@graft/toolbox`'s README says how the
 * store's tree and the mount are one.
 */
export type ToolboxReader = Pick<ToolboxStore, "readTree">;

/** `publish_tool`'s publish — `@graft/publish`'s `publishToolVersion` with its deps bound. */
export type PublishTool = (args: PublishArgs) => Promise<PublishOutcome>;

export type McpDeps = {
  db: DbOrTx;
  agent: AgentDeps;
  connection: ConnectionDeps;
  tool: ToolDeps;
  workingSet: WorkingSetDeps;
  ledger: LedgerDeps;
  /**
   * The seam (ADR 0002): Docker in this repository, the hosted backing privately, the fake in tests.
   * Null when the deployment configured none — the server boots and every run refuses, saying so,
   * rather than the boot failing for a feature the deployment may not need yet.
   */
  sandbox: SandboxBackend | null;
  /** An agent's sandbox is `<prefix>-<agentId>`; the backing adds its own prefix in front. */
  sandboxNamePrefix?: string;
  /** The deployment's key pair, or null: every run then refuses `proxy_unconfigured` before touching a sandbox. */
  keys: CapabilityTokenKeys | null;
  /** What a sandbox is handed as `GRAFT_PROXY_URL` (ADR 0010) — `GRAFT_PROXY_PUBLIC_URL`. */
  proxyPublicUrl: string;
  /**
   * Where the MCP endpoint's protected resource metadata answers (RFC 9728; ADR 0018) —
   * `@graft/core`'s `protectedResourceMetadataUrl(GRAFT_AUTH_URL)`. Named in the `WWW-Authenticate`
   * challenge every 401 carries, which is how a chat product discovers the authorization server
   * from the endpoint alone. Absent, the 401 carries no challenge and only a static token gets in.
   */
  resourceMetadataUrl?: string;
  checkModule: ModuleCheck;
  runnerFiles: () => Promise<RunnerFile[]>;
  skills: () => Promise<Skill[]>;
  readWebPage: ReadWebPage;
  /** The store, for `read_tool_source`; absent, the tool reads through the agent's sandbox instead. */
  toolbox?: ToolboxReader | null;
  /** Absent, `publish_tool` refuses `publish_unconfigured`. */
  publishTool?: PublishTool | null;
  /**
   * The ask card's page, the body of `resources/read` for `ui://graft/ask` (`ask-card.ts`,
   * GRA-84) — `@graft/ask-card`'s built `dist/ask.html` by default, read once. A test hands in a
   * string; a deployment never sets it.
   */
  askCardHtml?: () => Promise<string>;
  /**
   * The chat products whose OAuth clients may answer the ask card, by the host their redirect
   * URIs are on — `GRAFT_CARD_HOSTS` (`tools/answer-ask.ts`; ADR 0006 as amended 2026-09-18).
   * `DEFAULT_CARD_HOSTS` when absent.
   */
  cardHosts?: readonly string[];
  /** The read of an OAuth client's registration the same gate makes — `@graft/db/repo/mcp-oauth`'s, as `listPendingActionsByKind` is. */
  findMcpClient: typeof findMcpClient;
  /** The `tools/list_changed` rate limit's window (`notifier.ts`); a test sets it low. */
  listChangedWindowMs?: number;
  now?: () => Date;
  /** The approval and pending-action seams the ask flow reads and writes (`approval.ts`, ADR 0008). */
  approval: ApprovalDeps;
  pendingAction: PendingActionDeps;
  /** The one read the ask flow needs that the pending-action seam does not carry — `approval.ts` says why. */
  listPendingActionsByKind: typeof listPendingActionsByKind;
  /**
   * The advisory lock that serialises "find the open ask or make one" for a key, inside the
   * transaction that does both (`connection-request.ts`'s scope ask, GRA-104). The fake is a
   * no-op: an in-memory store has no concurrent transactions to serialise.
   */
  lockPendingActionKey: typeof lockPendingActionKey;
  /** The handoff's configuration — the console's URL, the signing secret, the wait and the TTL (`handoff.ts`). */
  handoff: HandoffConfig;
  /**
   * Where the callback route of an authorization-code consent answers — `oauthRedirectUri(GRAFT_AUTH_URL)`
   * (`@graft/core`) — so `request_connection` can tell the agent the one value the person has to paste
   * into the client they register (ADR 0005; `connection-request.ts`). Optional so a harness with no
   * OAuth in it needs nothing; `apps/server` always binds it, and the awaiting answer without it
   * points the person at the form instead.
   */
  oauthRedirectUri?: string;
  /**
   * `GRAFT_AUTH_URL` — the server's own origin, on which a link provider's return route answers
   * (ADR 0019; `apps/server/src/provider-link.ts`), so the ask card's `start_link` can mint a
   * link whose return lands there (`provider-link.ts`, GRA-117). Optional so a harness with no
   * link provider needs nothing; `apps/server` always binds it, and without it `start_link`
   * refuses with a sentence saying the console is the place.
   */
  authUrl?: string;
  /**
   * The `tools/list_changed` notifier, one per process, shared by the endpoint's sessions and the
   * sweep (`sweep.ts`) so a demotion the rule makes reaches the harness exactly as one the agent made
   * does (ADR 0003). `createMcpDeps` makes it; `createMcpHttpApp` makes its own when it is absent.
   */
  notifier?: ToolListChangedNotifier;
  /**
   * Which agents have a run in flight — held by every call path, read by the sweep, which skips an
   * agent while it is (ADR 0009; `in-flight.ts`). One per process; `createMcpDeps` makes it. Absent,
   * nothing is held and the sweep never skips.
   */
  inFlight?: InFlightRegistry;
  /** The `acquire` job's record — the job, its attempts, its trace (`acquire/job.ts`, ADR 0012). */
  acquireJob: AcquireJobDeps;
  /**
   * The model that answers `acquire` (ADR 0004; `@graft/model`). Null when the deployment configured
   * none — `acquire` then refuses `acquire_unconfigured` and the rest of the server is unaffected,
   * the sandbox's posture.
   */
  model?: ModelAdapter | null;
  /** The bounds every job is held to; `DEFAULT_ACQUIRE_CONFIG` when absent. */
  acquire?: AcquireConfig;
  /**
   * The in-process job runner's handle (`acquire/runner.ts`), so the meta-tool can wake it the
   * moment a job is queued rather than leave the job to the next poll. Absent, a job waits queued
   * for a runner — which is what a process that starts none, the sweep script say, wants.
   */
  acquireRunner?: { kick(): void };
  /**
   * Fired once per tool call from the one dispatch point (`tools.ts`'s `callToolFor`), after the
   * answer is known and before it is returned — the hook the server binds its wide event and its
   * analytics to (GRA-100). What it carries is what a chart cuts by, and nothing a person typed:
   * the tool's wire name and kind, the agent and the person, the outcome, the refusal's reason when
   * there is one, the latency. Absent, a call is exactly what it was.
   */
  onToolCall?: (event: ToolCallEvent) => void;
};

/**
 * One tool call as the hook sees it. `kind` is which of the three lists the name came from
 * (ADR 0003): a fixed meta-tool, a connection's execute tool, or an authored tool in the working
 * set — an unknown name is reported as `authored`, since that is the list it would have been in.
 * `outcome` is MCP's `isError` read back: `refused` when the answer is Graft's own refusal shape
 * (`result.ts`), `error` for a run's failure or an internal one, `ok` otherwise — an awaiting
 * answer included, since it is a result and not an error (GRA-112, `result.ts`'s `toolAwaiting`).
 */
export type ToolCallEvent = {
  tool: string;
  kind: "meta" | "execute" | "authored";
  agentId: string;
  personId: string;
  outcome: "ok" | "refused" | "error";
  /** The refusal's `reason` — `connection_not_in_scope`, `approval_declined`, … — when `outcome` is `refused`. */
  reason?: string;
  latencyMs: number;
};

export type CreateMcpDepsInput = Pick<
  McpDeps,
  "db" | "connection" | "sandbox" | "keys" | "proxyPublicUrl" | "handoff"
> &
  Partial<
    Omit<McpDeps, "db" | "connection" | "sandbox" | "keys" | "proxyPublicUrl" | "handoff">
  > & {
    /** The publish's deps, bound once by the server; the store inside them is `read_tool_source`'s. */
    publish?: PublishDeps | null;
  };

/**
 * The real deps, given what only the server knows: the database handle, the connection deps (which
 * carry the vault's encrypt half), the sandbox backing the environment selected, the key pair, the
 * proxy's public URL, the handoff's configuration and the publish's deps. Everything else has one default — the core's
 * `default*Deps`, the check, the runner and skills shipped with `@graft/runner`, the page reader —
 * and may be overridden.
 */
export function createMcpDeps(input: CreateMcpDepsInput): McpDeps {
  const { publish, ...rest } = input;
  return {
    agent: defaultAgentDeps,
    tool: defaultToolDeps,
    workingSet: defaultWorkingSetDeps,
    ledger: defaultLedgerDeps,
    approval: defaultApprovalDeps,
    pendingAction: defaultPendingActionDeps,
    acquireJob: defaultAcquireJobDeps,
    listPendingActionsByKind,
    lockPendingActionKey,
    findMcpClient,
    checkModule,
    runnerFiles,
    skills: loadSkills,
    readWebPage: (args) => readWebPage(args),
    toolbox: publish?.store ?? null,
    publishTool: publish ? (args) => publishToolVersion(publish, args) : null,
    askCardHtml: () => readAskCardHtml(),
    notifier: createToolListChangedNotifier({ windowMs: input.listChangedWindowMs }),
    inFlight: createInFlightRegistry(),
    ...rest,
  };
}
