// The door and its shapes only. The rule vocabulary and the core live in `./module-check.core`, which
// loads the TypeScript compiler when imported; reach for it by its own path, knowingly.
export {
  type AdviceRule,
  checkModule,
  type Diagnostic,
  type DiagnosticRule,
  dependenciesOf,
  MODULE_CHECK_MAX_BYTES,
  MODULE_CHECK_TIMEOUT_MS,
  type ModuleCheck,
  type ModuleCheckFile,
  type ModuleCheckInput,
  type ModuleCheckResult,
  type ModuleFile,
  type ModuleSources,
  type RefusalRule,
  readModuleSources,
  singleFileModule,
  type ToolAnnotations,
  UNKNOWN_ANNOTATIONS,
} from "./module-check";
