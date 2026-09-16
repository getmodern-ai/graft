# GRA-3 final report (check + runner), merged as PR #4 (main 6fed356)

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Contracts below are what GRA-18 (publish) and GRA-19 (MCP server) must match.

## Packages

- `packages/runner` → `@graft/runner`: `src/runner.mjs`, `src/runner-source.ts`, `src/skills.ts`, `skills/authoring-a-tool/SKILL.md`. No runtime dependencies.
- `packages/check` → `@graft/check`: `src/module-check.core.ts` (loads the compiler), `src/module-check.ts` (the door: budgets, worker), `src/module-check.worker.ts`, `src/annotations.ts`. Pins `"typescript6": "npm:typescript@~6.0.3"` in its own package.json and depends on `@graft/runner` (for `moduleEntryOf`). `allowImportingTsExtensions: true` in its tsconfig.

## The `Context` declaration (exact)

```ts
{ fetch(path: string, init?: RequestInit): Promise<Response>; proxyBase(host?: string): string; proxyKey: string; connection: string | null }
```

Runner builds `Object.freeze({ fetch, proxyBase, proxyKey: token ?? "", connection: connection ?? null })`.

- `fetch(path, init)`: vendor-relative path under `${GRAFT_PROXY_URL}/c/${GRAFT_CONNECTION}/`, adds `Authorization: Bearer ${GRAFT_TOKEN}`; absolute URLs and paths that leave the connection are refused before any request.
- `proxyBase(host?)`: `${PROXY_URL}/c/${CONNECTION}` or `${PROXY_URL}/c/${CONNECTION}/h/${host}`; host must match a hostname regex (optionally `:port`); throws "unavailable" when no connection is bound.
- `proxyKey`: the per-exec capability token, `""` when unbound.
- `connection`: connection id or `null`.

## Check input and output shapes

```ts
type ModuleFile = { path: string; content: string };
type ModuleSources = { files: ModuleFile[]; entry: string | null; dependencies: string[] };
function readModuleSources(files: readonly ModuleFile[]): ModuleSources;   // directory tree → entry via runner order (index.ts, index.mjs) or null; dependencies = top-level package.json `dependencies` keys, sorted
function singleFileModule(path: string, content: string): ModuleSources;
function dependenciesOf(files: readonly ModuleFile[]): string[];

const checkModule: (
  input: { files: readonly ModuleFile[]; entry: string | null; inputSchema?: Record<string, unknown> | null; dependencies?: readonly string[] | null },
  options?: { timeoutMs?: number; maxBytes?: number },   // defaults 10_000 ms, 256 KiB
) => Promise<ModuleCheckResult>;

type Diagnostic = { file: string; line: number; column: number; text: string; message: string; hint: string; rule: DiagnosticRule };
type ToolAnnotations = { readOnly: boolean; destructive: boolean };
const UNKNOWN_ANNOTATIONS: ToolAnnotations = { readOnly: false, destructive: true };
type ModuleCheckResult = { entry: string | null; refusals: Diagnostic[]; advice: Diagnostic[]; annotations: ToolAnnotations };
```

Annotation derivation: `ctx.fetch` with no init, or literal `method` GET/HEAD → read; literal DELETE → destructive; any other literal → write; non-literal init, shorthand `{ method }`, spread, computed method → write; every call rooted in an SDK binding → write. `readOnly = writes === 0 && deletes === 0`; `destructive = deletes > 0`. Never from the module's own declarations.

## Rule names

Refusals (19): `syntax`, `default-export-missing`, `default-export-not-async`, `default-export-arity`, `default-export-type`, `type-error`, `type-import`, `execute-environment`, `banned-module`, `import-outside-module`, `import-not-vendored` (new), `import-unresolved`, `fetch-absolute-url`, `global-fetch`, `sdk-not-bound` (new), `non-erasable-syntax`, `entry-missing`, `budget`, `check-failed`.

Advice (5): `implicit-any`, `unread-input-field`, `non-json-return`, `no-return`, `no-input-schema`.

Exported constants: `SDK_CREDENTIAL_OPTIONS` (22 names), `SDK_BASE_OPTIONS` (19 names), `BANNED_MODULES`, `CONTEXT_DECLARATION`, `RUNTIME_DECLARATIONS`, `inputTypeFromSchema`.

`sdk-not-bound` scope: every `new X(...)` whose root identifier is bound to a bare-package import (direct, via variable, namespace access, require/import(), sibling re-export; fixpoint), plus factory calls with an object literal carrying a credential or base option. Refused: no credential slot, no base slot, credential not `ctx.proxyKey`, base not a `ctx.proxyBase(...)` call, spread or computed key, auth-shaped header in `headers`/`defaultHeaders`/`customHeaders`/`extraHeaders`; `@slack/web-api` without literal `allowAbsoluteUrls: false`. Vendored packages type-check as `any` via an ambient `/graft/vendored.d.ts` per dependency.

## Runner environment and exit codes

Read once then every `GRAFT_*` key is deleted before the module is imported: `GRAFT_PROXY_URL`, `GRAFT_CONNECTION`, `GRAFT_TOKEN`, `GRAFT_TIMEOUT_MS` (default 60000), `GRAFT_RESULT_PATH` (detached; stdout carries `__GRAFT_RESULT__:<path>`), `GRAFT_DRY_RUN` (`"1"`). `NODE_USE_ENV_PROXY=1` must come from the caller.

Exit codes: `EXIT_OK = 0`, `EXIT_THREW = 1`, `EXIT_TIMEOUT = 2`, `EXIT_USAGE = 64`. A dry run exits 0 with the report whether or not the module threw.

Constants from `runner-source.ts`: `RUNNER_DIR = "/graft"`, `RUNNER_FILE = "runner.mjs"`, `RUNNER_PATH = "/graft/runner.mjs"`, `MODULE_ENTRIES = ["index.ts", "index.mjs"]`, `MODULE_ENTRY = "index.ts"`, `moduleEntryOf(names)`, `moduleEntryFor(path)`, `DRY_RUN_HEADER = "x-graft-dry-run"`, `DRY_RUN_INTERCEPTED = "intercepted"`, `RESULT_MARKER = "__GRAFT_RESULT__:"`, `SKILLS_DIR = "/skills"`, `SKILLS_SOURCE_DIR`, `loadRunnerSource()`, `runnerFiles()`, `loadSkills()`, `loadSkillsFrom(dir)`, `parseSkill(raw)`, `skillFiles(skills)`, `resetSkillCache()`. Dry-run report shape unchanged from Cando: `{ dryRun, passed, reads, writesPreviewed, writesRefused, omitted?, moduleResult?|moduleError?, verified, unverified }`.

## Decisions taken

1. `proxyKey` is `""` when unbound; `proxyBase()` throws "unavailable" when unbound, like `fetch`.
2. `connection` stays on `ctx`, now declared to the checker, `string | null`.
3. `UNKNOWN_ANNOTATIONS = { readOnly: false, destructive: true }` for a module the check could not read.
4. `annotations.ts` is separate so the door never loads the compiler on the main thread.
5. `RUNNER_SOURCE_PATH` and `SKILLS_SOURCE_DIR` resolve off `import.meta.url`, not `process.cwd()`; a future bundler must carry `runner.mjs` and `skills/` beside the bundle.
6. `DRY_RUN_HEADER`, `RESULT_MARKER`, `MODULE_ENTRIES` exported and pinned by `runner.test.ts`; GRA-5's proxy is the other holder of `x-graft-dry-run` and a later ticket should assert agreement across packages.
7. Skills not copied: `connecting-an-app`, `what-we-cannot-do-yet`. `skills.test.ts` asserts no Cando vocabulary survives in the shipped skill.
8. Skill caveat: an SDK's calls cross the proxy with the dry-run claim but not through `ctx.fetch`, so they are absent from the report's `reads`/`writesPreviewed`; an SDK module is proven by `moduleResult`/`moduleError`. (Follow-up candidate: the proxy's wide events per exec could feed the report.)
9. ADR 0010 amended ("Amended 9 September 2026").
10. Tool names in the skill keep Cando's (`check_tool`, `publish_tool`, `run_published_tool`, `execute`, `run_command`, `wait_for_process`, `read_web_page`, `read_tool_source`, `write_file`); GRA-19 may rename.
