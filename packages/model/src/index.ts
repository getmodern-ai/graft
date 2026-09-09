/**
 * `@graft/model` — the model adapter seam `acquire`'s job drives (ADR 0004), its scripted backing
 * (`./scripted`) and the provider-backed one (`./provider`, GRA-31) with the per-person router in
 * front of both (`./routed`, ADR 0014). The conformance suite every backing runs is
 * `@graft/model/conformance` and is deliberately not re-exported here: it imports the test runner,
 * and the server imports this index. Langfuse is `@graft/model/langfuse`, for the same reason
 * in the other direction — a consumer that wants the adapter need not load OpenTelemetry.
 */
export {
  draftProblems,
  ModelAnswerInvalidError,
  type ReadAnswer,
  readWireAnswer,
  TOOL_DESCRIPTION_MAX_LENGTH,
  WIRE_ANSWER_SCHEMA,
  WIRE_DRAFT_SCHEMA,
  type WireAnswer,
  type WireDraft,
  wireOf,
} from "./answer";
export {
  AUTHORING_MAX_OUTPUT_TOKENS,
  createProviderModel,
  MODEL_PROVIDERS,
  type ModelProviderName,
  PROVIDER_MODEL_DEFAULTS,
  type ProviderModel,
  type ProviderModelConfig,
  type ProviderModelDeps,
  type ProviderModelSettings,
  providerModels,
  type ResolvedModels,
  resolveModelSettings,
} from "./provider";
export {
  createRoutedModel,
  type ModelRoute,
  type ModelRouteResolver,
  ModelUnavailableError,
  ROUTED_MODEL_NAME,
  type RoutedModelOptions,
} from "./routed";
export {
  createScriptedModel,
  DEFAULT_SCRIPTED_USAGE,
  parseScript,
  SCRIPTED_MODEL_NAME,
  ScriptExhaustedError,
  type ScriptedConversationRecord,
  type ScriptedModel,
  type ScriptedStep,
  ScriptMismatchError,
} from "./scripted";
export {
  type ModelCallTrace,
  type ModelRole,
  type ModelTelemetry,
  NO_TELEMETRY,
} from "./telemetry";
export { DOC_SUMMARY_THRESHOLD_CHARS, urlsIn } from "./triage";
export {
  ANSWERS_FOR,
  answerAllowed,
  type ConnectionBrief,
  type DocPage,
  type DryRunSummary,
  isValidUsage,
  type ModelAdapter,
  type ModelAnswer,
  type ModelAnswerKind,
  type ModelConversation,
  type ModelDiagnostic,
  type ModelJobContext,
  type ModelReply,
  type ModelSituation,
  type ModelSituationKind,
  type ModelUsage,
  type ModuleDraft,
  type ModuleFile,
  type ProofRead,
} from "./types";
