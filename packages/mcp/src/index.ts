/**
 * `@graft/mcp` — the MCP server a harness connects to (CONTEXT.md, *Harness*): the fixed meta-tools
 * plus exactly the authored tools promoted for the connecting agent (ADR 0003), over streamable
 * HTTP with a bearer token per agent (ADR 0007). `apps/server` mounts `createMcpHttpApp` and builds
 * `McpDeps` from its environment; a test drives `createAgentSession` over the SDK's in-memory
 * transport.
 */
export {
  attemptDraftPath,
  DEFAULT_HEARTBEAT_MS,
  MAX_DOCS_PER_TURN,
  MAX_PROOF_READS,
  PROBE_MODULE,
  probePath,
  type RunAcquireJobOptions,
  runAcquireJob,
  turnBudgetFor,
} from "./acquire/job";
export {
  type AcquireRunner,
  type AcquireRunnerEvent,
  type AcquireRunnerOptions,
  createAcquireRunner,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_STALE_AFTER_SECONDS,
} from "./acquire/runner";
export {
  ACQUIRE_FAILURES,
  type AcquireAttemptSummary,
  type AcquireConfig,
  type AcquireFailure,
  type AcquireFailureKind,
  type AcquireResult,
  type AcquireStarted,
  type AcquireStatus,
  type AcquireSuccess,
  acquireStatusOf,
  DEFAULT_ACQUIRE_CONFIG,
  isAcquireFailure,
} from "./acquire/shapes";
export {
  type ApprovalAnswer,
  type ApprovalAskKind,
  type AskChannel,
  type AwaitingApproval,
  type BuildAskPayload,
  DEFAULT_POLL_MS,
  DESCRIPTION_PROVENANCE_NOTE,
  describeAsk,
  type ElicitForm,
  elicitationSchemaFor,
  type GateOutcome,
  gateToolCall,
  NO_ELICITATION,
  readApprovalAnswer,
  requireBuildApproval,
  type ToolAskPayload,
} from "./approval";
export {
  clampTimeout,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_DETACHED_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_DETACHED_TIMEOUT_SECONDS,
} from "./bounds";
export type { SessionContext } from "./context";
export {
  type CreateMcpDepsInput,
  createMcpDeps,
  type McpDeps,
  type PublishTool,
  type ToolboxReader,
} from "./deps";
export {
  HANDOFF_PATH,
  HANDOFF_TOKEN_PARAM,
  type HandoffConfig,
  type HandoffSubject,
  type HandoffVerdict,
  handoffUrl,
  signHandoffToken,
  verifyHandoff,
} from "./handoff";
export { createMcpHttpApp, type McpHttpOptions } from "./http";
export {
  createInFlightRegistry,
  detachedHoldMs,
  heldInFlight,
  type InFlightRegistry,
  isSettledProcess,
  trackDetachedStart,
} from "./in-flight";
export {
  createToolListChangedNotifier,
  DEFAULT_LIST_CHANGED_WINDOW_MS,
  type ToolListChangedNotifier,
} from "./notifier";
export { promotePublished } from "./promote";
export { type Refusal, refusal } from "./result";
export {
  type AuthoredRunAnswer,
  type AuthoredRunArgs,
  EXIT_MODULE_MISSING,
  type RunFailure,
  type RunMode,
  runAuthoredTool,
  runWithCapability,
  TOKEN_SLACK_SECONDS,
  tokenTtlFor,
} from "./run";
export {
  agentSandboxName,
  DEFAULT_SANDBOX_NAME_PREFIX,
  DRAFTS_ROOT,
  draftsDir,
  openAgentSandbox,
  RUN_SCRATCH_DIR,
  TOOLBOX_DIR,
} from "./sandbox";
export {
  type AgentSession,
  createAgentSession,
  openAgentSession,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
} from "./session";
export {
  type RunSweepOptions,
  runSweep,
  type StartSweepOptions,
  type SweepDemotion,
  type SweepHandle,
  type SweepReport,
  startSweep,
} from "./sweep";
export {
  authoredToolName,
  EXECUTE_TOOL_PREFIX,
  executeToolName,
  MCP_TOOL_NAME,
  parseAuthoredToolName,
  parseExecuteToolName,
  TOOL_NAME_SEPARATOR,
} from "./tool-names";
export { authoredToolDefinition, META_TOOL_NAMES } from "./tools";
export { type ReadWebPage, readWebPage, type WebPageResult } from "./web-page";
