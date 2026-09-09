/**
 * `@graft/core` — persons, agents, connections, the toolbox, the working set, approvals, pending
 * actions, `acquire` jobs and the ledger (GRA-1, "The core and its seams"), as services with
 * injected dependencies that run without a database. The `*.deps.ts` beside each service binds the
 * real repositories; a test passes fakes.
 */

export { type AcquireJobDeps, defaultAcquireJobDeps } from "./acquire-job/acquire-job.deps";
export {
  type AppendAcquireTraceInput,
  appendAcquireJobProgress,
  appendAcquireTrace,
  claimRunnableAcquireJobs,
  completeAcquireJob,
  createAcquireJob,
  type FinishAcquireAttemptInput,
  finishAcquireAttempt,
  GOAL_MAX_LENGTH,
  getAcquireJob,
  HINTS_MAX_LENGTH,
  heartbeatAcquireJob,
  listAcquireAttempts,
  listAcquireJobs,
  listAcquireTraces,
  recordAcquireJobAttempt,
  recordAcquireJobTokens,
  type StartAcquireAttemptInput,
  startAcquireAttempt,
  startAcquireJob,
  TRACE_READ_LIMIT,
  TRACE_TEXT_MAX_LENGTH,
} from "./acquire-job/acquire-job.service";
export {
  GENERIC_SECRET_FIELD_NAMES,
  MIN_SECRET_LENGTH,
  REDACTED,
  type RedactionRule,
  redactText,
  redactValue,
  secretFieldNamesFor,
} from "./acquire-job/redaction";
export { type AgentDeps, defaultAgentDeps } from "./agent/agent.deps";
export {
  type ActiveAgentScope,
  AGENT_NAME_MAX_LENGTH,
  type AgentLimitsPatch,
  type AgentOutput,
  addConnectionToAgentScope,
  type CreateAgentInput,
  createAgent,
  getAgent,
  getAgentScope,
  IDLE_WINDOW_DAYS_RANGE,
  listActiveAgentScopes,
  listAgents,
  revokeAgent,
  setAgentScope,
  toAgentOutput,
  updateAgentLimits,
  WORKING_SET_CAP_RANGE,
} from "./agent/agent.service";
export {
  type ApprovalState,
  type ApprovalVerdict,
  approvalDecision,
  type ToolAnnotations,
} from "./approval/approval.decision";
export { type ApprovalDeps, defaultApprovalDeps } from "./approval/approval.deps";
export {
  decideToolCall,
  getApproval,
  getBuildApproval,
  grantBuildApproval,
  listApprovals,
  relaxDestructiveApproval,
  revokeApproval,
  setApproval,
} from "./approval/approval.service";
export { type ConnectionDeps, createConnectionDeps } from "./connection/connection.deps";
export {
  DISPLAY_NAME_MAX_LENGTH,
  HOST_NOT_PUBLIC,
  type HostSetRefusal,
  type HostSetVerdict,
  SCHEME_PARAMETERS,
  VENDOR_MAX_LENGTH,
  validateCredentialFields,
  validateDisplayName,
  validateHostSet,
  validateIssuedCredentialFields,
  validateSchemeConfig,
  validateVendor,
} from "./connection/connection.rules";
export {
  type ConnectionOutput,
  completeOAuthConsent,
  getConnection,
  isConnectionUsable,
  listConnections,
  markOAuthConsentRequired,
  type RegisterConnectionInput,
  type RegisterConnectionWithCredentialInput,
  type RevokeConnectionResult,
  registerConnection,
  registerConnectionWithCredential,
  revokeConnection,
  type StartedOAuthConsent,
  type StartOAuthConsentInput,
  setConnectionCredential,
  startOAuthConsent,
  storeRefreshedCredential,
  toConnectionOutput,
  toProxyConnection,
} from "./connection/connection.service";
export {
  GOOGLE_TESTING_MODE_NOTICE,
  hasGoogleHost,
  isGoogleHost,
  isOAuthAuthorizationCode,
  OAUTH_AUTHORIZATION_CODE,
  OAUTH_CALLBACK_PATH,
  type OAuthPublicState,
  type OAuthState,
  type OAuthStatus,
  oauthPublicState,
  oauthRedirectUri,
  readOAuthState,
} from "./connection/oauth.rules";
export {
  buildAuthorizeUrl,
  generatePkce,
  OAUTH_STATE_TTL_MS,
  type OAuthStatePayload,
  type OAuthStateVerdict,
  pkceChallenge,
  signOAuthState,
  verifyOAuthState,
} from "./connection/oauth-consent";
export type { ServiceContext } from "./context";
export {
  HTTP_STATUS_BY_CODE,
  orNotFound,
  ServiceError,
  type ServiceErrorCode,
} from "./errors";
export { isKebabCase } from "./kebab-case";
export { defaultLedgerDeps, type LedgerDeps } from "./ledger/ledger.deps";
export {
  lastUsedAtByTool,
  listUsage,
  listVendorUsage,
  recordUsage,
  type UsageInput,
  type VendorUsageRow,
} from "./ledger/ledger.service";
export {
  defaultPendingActionDeps,
  type PendingActionDeps,
} from "./pending-action/pending-action.deps";
export {
  answerPendingAction,
  type CreatePendingActionInput,
  consumePendingAction,
  createPendingAction,
  DEFAULT_PENDING_ACTION_TTL_MS,
  getPendingAction,
  getPendingActionForPerson,
  listOpenPendingActions,
  MAX_PENDING_ACTION_TTL_MS,
} from "./pending-action/pending-action.service";
export {
  AGENT_TOKEN_DISPLAY_LENGTH,
  AGENT_TOKEN_PREFIX,
  type AgentScope,
  type AgentTokenDeps,
  bearerTokenFrom,
  hashAgentToken,
  type MintedAgentToken,
  mintAgentToken,
  type Principal,
  requireAgent,
  requirePerson,
  type SessionLike,
} from "./tenancy";
export { defaultToolDeps, type ToolDeps } from "./tool/tool.deps";
export {
  addToolVersion,
  type CreateToolInput,
  createTool,
  getToolById,
  getToolByName,
  getToolVersion,
  listTools,
  listToolVersions,
  moveToolPointer,
  nextVersionNumber,
  publishToolVersion,
  recordDryRun,
  TOOL_DESCRIPTION_MAX_LENGTH,
  TOOL_NAME_MAX_LENGTH,
  type ToolDefinitionPatch,
  type ToolVersionInput,
  updateToolDefinition,
  validateToolDefinition,
} from "./tool/tool.service";
export {
  DAY_MS,
  type SweepCause,
  type SweepDecision,
  type SweepDecisionInput,
  type SweepDemotion,
  type SweepEntry,
  sweepDecision,
} from "./working-set/sweep.decision";
export { defaultWorkingSetDeps, type WorkingSetDeps } from "./working-set/working-set.deps";
export {
  countWorkingSet,
  demoteTool,
  isPromoted,
  listWorkingSet,
  listWorkingSetChanges,
  promoteTool,
  touchToolUsed,
  type WorkingSetChange,
} from "./working-set/working-set.service";
