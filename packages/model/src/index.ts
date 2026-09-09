/**
 * `@graft/model` — the model adapter seam `acquire`'s job drives (ADR 0004), its scripted backing
 * (`./scripted`) and the conformance suite a provider-backed one runs (`./conformance`, GRA-31).
 */
export {
  CONFORMANCE_CONTEXT,
  CONFORMANCE_PAGE,
  draftProblems,
  type ModelConformanceFixture,
  modelConformance,
} from "./conformance";
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
