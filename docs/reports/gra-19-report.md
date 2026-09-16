# GRA-19 final report (MCP server), merged as PR #9 (main 22a3445)

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Paths are repo-relative on `main`. Final pushed SHA `00a5d27b435ed01426516bc8bf2dd35740516c6d`. CI green, approved by sebapoole, Greptile posted nothing. Local: `check`, `lint`, `check-types` (15/15), `test --force` with `Cached: 0` (mcp 45 tests across 6 suites; server 29 + integration skipped without Postgres).

## `McpDeps` (`packages/mcp/src/deps.ts`) and how `apps/server` builds it

```ts
export type ToolboxReader = Pick<ToolboxStore, "readTree">;                 // @graft/toolbox
export type PublishTool = (args: PublishArgs) => Promise<PublishOutcome>;   // @graft/publish

export type McpDeps = {
  db: DbOrTx;
  agent: AgentDeps;               // GRA-6 seams, passed through as they are
  connection: ConnectionDeps;
  tool: ToolDeps;
  workingSet: WorkingSetDeps;
  ledger: LedgerDeps;
  sandbox: SandboxBackend | null; // null = no backing configured; runs refuse, boot succeeds
  sandboxNamePrefix?: string;     // default "agent" → sandbox `agent-<agentId>`
  keys: CapabilityTokenKeys | null;
  proxyPublicUrl: string;         // handed to sandboxes as GRAFT_PROXY_URL
  checkModule: ModuleCheck;
  runnerFiles: () => Promise<RunnerFile[]>;
  skills: () => Promise<Skill[]>;
  readWebPage: ReadWebPage;
  toolbox?: ToolboxReader | null;   // read_tool_source; falls back to the sandbox when absent
  publishTool?: PublishTool | null; // absent → publish_tool refuses `publish_unconfigured`
  listChangedWindowMs?: number;     // default 2000
  now?: () => Date;
};
export function createMcpDeps(input: Pick<McpDeps,"db"|"connection"|"sandbox"|"keys"|"proxyPublicUrl">
  & Partial<McpDeps> & { publish?: PublishDeps | null }): McpDeps
// defaults: defaultAgentDeps/ToolDeps/WorkingSetDeps/LedgerDeps, checkModule, runnerFiles, loadSkills, readWebPage;
// toolbox = publish?.store ?? null; publishTool = publish ? (args) => publishToolVersion(publish, args) : null
```

`apps/server/src/index.ts`: `connectionDeps = createConnectionDeps({ encrypt: vault.encrypt })`; if `GRAFT_SANDBOX_BACKEND === "fake"` → `fake = createFakeSandboxBackend()`, `sandbox = fake`, `toolboxRoot = join(fake.root, "toolboxes")`; else `toolboxRoot = GRAFT_TOOLBOX_ROOT` and `sandbox = (IMAGE && NETWORK) ? createDockerSandboxBackend({ image, network, toolboxHostRoot: toolboxRoot }) : null`. Then `store = createFilesystemToolboxStore({ root: toolboxRoot })`, `publish = createPublishDeps({ db, store, mirror: createNoopToolboxMirror(), sandbox: sandbox ?? { install: <failed result naming the missing pair> }, metadata: createRegistryMetadataSource(), policy: { allowlist: [...DEFAULT_PACKAGE_POLICY.allowlist, ...GRAFT_PACKAGE_ALLOWLIST], minAgeDays, minWeeklyDownloads } })`, and `createServer({ …, mcp: createMcpDeps({ db, connection: connectionDeps, sandbox, keys, proxyPublicUrl: env.GRAFT_PROXY_PUBLIC_URL, publish }) })`. `createServer` mounts `createMcpHttpApp(deps.mcp)` at `MCP_MOUNT_PATH = "/mcp"`, outside `/api` and its CORS.

## Meta-tools (exact names; every schema `type: "object"`, `additionalProperties: false`)

| Tool | Input | Answer |
|---|---|---|
| `acquire` | `{ connectionId, goal, hints? }` | stub `{ error: "not_available_yet", ticket: "GRA-29", message }` |
| `acquire_status` | `{ jobId }` | stub GRA-29 |
| `find_tool` | `{ query }` | `{ tools: [{ vendor, name, tool, description, promoted, annotations: { readOnlyHint, destructiveHint } }], note }` — substring over vendor/name/description, demoted included, never another person's |
| `promote` / `demote` | `{ vendor, name }` | `{ tool, promoted, changed, workingSetSize }`; cause `"agent"`; notifies when `changed` |
| `run_tool` | `{ vendor, name, input?: object, dryRun?, detached?, timeoutSeconds?: 1..3600 }` | run path below |
| `request_connection` | `{ vendor, primaryHost, scheme, displayName?, hosts?, schemeConfig?, docsUrl? }` | stub GRA-28 |
| `request_credential` | `{ connectionId, reason? }` | stub GRA-28 |
| `write_file` | `{ path, content }` (relative → `/tools/.drafts/<agentId>/…`) | `{ path, bytes }` |
| `read_file` | `{ path }` | `{ path, content, truncated, totalCharacters? }` |
| `run_command` | `{ command, timeoutSeconds?, detached? }` | `{ exitCode, output, outputTruncated?, status?, note? }` or detached `{ status: "running", processName, startedAt, timeoutSeconds, resultPath, note }` |
| `wait_for_process` | `{ processName, maxWaitSeconds?: 1..600 }` | `{ status: running\|completed\|failed\|killed, processName, exitCode, stdout, stderr?, result?/resultPath?/resultError?, error?, note? }` |
| `read_web_page` | `{ url, offset? }` | `{ ok: true, url, title, content, offset, totalCharacters, truncated, nextOffset, note }` or `{ ok: false, url, error }` |
| `check_tool` | `{ path, inputSchema? }` | `{ ok, entry, refusals, advice, annotations: { readOnly, destructive }, note }` |
| `publish_tool` | `{ vendor, name, description, inputSchema, path, testInput?, connectionId? }` | `{ ok: true, tool, version, path, annotations, advice, dependencies, promoted: true, dryRun?, note }`; refusal = `PublishRefusal` + `note`, `isError` |
| `read_tool_source` | `{ vendor, name }` | `{ tool, version, path, annotations, files: [{ path, content }] }` |
| `execute__<connectionId>` | `{ command, timeoutSeconds?, detached?, dryRun? }` | as `run_command`; token claim `tool: "execute"`; one per connection in scope |

First-class authored tools are `<vendor>__<name>` with the stored `inputSchema` verbatim and `annotations` from the row (`readOnlyHint: readOnly`, `destructiveHint: destructive`); the server advertises `tools.listChanged: true`. An unknown or not-promoted name is a JSON-RPC `McpError(InvalidParams)`.

## Run path (`runAuthoredTool(deps, scope, { vendor, name, input, mode: { detached, timeoutSeconds, dryRun } })`)

Returns `{ isError: false, answer: unknown } | { isError: true, answer: Record<string, unknown> }`; wrapped as `content: [{ type: "text", text: JSON }]` (+ `structuredContent` for plain objects, `isError` on refusal/failure).

- Success: the module's result verbatim (the vendor body); >64k chars → `{ result: null, truncated: true, head, note }`. Detached: `{ status: "running", processName, startedAt, timeoutSeconds, resultPath, note }`. Dry run: `{ dryRun: <runner report> }`, recorded on the version via `recordDryRun`.
- Refusal: `{ error: "refused", reason, message }` — `tool_not_found`, `tool_has_no_version`, `connection_not_bound`, `connection_not_in_scope`, `input_schema_invalid`, `input_invalid`, `proxy_unconfigured`, `token_mint_failed`.
- Failure (Cando's shape): `{ error: <sentence>, exitCode: number | null, stderrTail }` — 1 "failed (exit code 1)", 2 "timed out inside the runner", 64 "runner refused the invocation", 66 (`EXIT_MODULE_MISSING`, after one remount and retry) "not on the toolbox", plus killed/still-running/non-JSON stdout.
- Every exit writes a ledger row (`ok` for a result or detached start, `error`, `refused`; `toolName` = wire name, `dryRun`), and `touchToolUsed` runs whenever the runner ran. Order is scope check → schema → mint → sandbox (`ensure`, `mountToolbox` first, seed runner/skills if absent) → `node /graft/runner.mjs /tools/tools/<vendor>/<name>/v<N>` with `GRAFT_PROXY_URL/CONNECTION/TOKEN/TIMEOUT_MS` (+`GRAFT_DRY_RUN`), `NODE_USE_ENV_PROXY=1`. GRA-23's `decideToolCall` slots between the scope check and the mint (comment marks the spot).

## Notifier (`packages/mcp/src/notifier.ts`)

```ts
DEFAULT_LIST_CHANGED_WINDOW_MS = 2_000
createToolListChangedNotifier({ windowMs? }): {
  attach(agentId, send: () => Promise<void>): () => void;  // returns detach; sessions attach server.sendToolListChanged
  changed(agentId): void;   // leading edge at once; changes inside the window coalesce into one trailing send
  close(): void;
}
```
Per agent across all its sessions; failed sends are dropped. One notifier per `createMcpHttpApp(deps, { notifier?, sessionIdGenerator? })`; `openAgentSession(deps, token, notifier)` / `createAgentSession(deps, scope, notifier)` return `{ server, scope, close }`.

## ToolboxReader / publish wiring

`toolbox = publish.store` (a `ToolboxStore`); `read_tool_source` calls `readTree(toolboxIdOf(personId), version.path)`, else `handle.downloadDirectory(sandboxPath(version.path))`. `publish_tool` strips `/tools/` off the resolved module path to get the toolbox-relative `draftPath` (a module outside `/tools` is refused), picks the default connection (given `connectionId`, or the single in-scope connection of the vendor; none/many refused), calls `publishToolVersion(publishDeps, { personId, agentId, toolboxId, vendor, name, description, inputSchema, draftPath, defaultConnectionId })`, then `promoteTool(…, "publish")`, `notifier.changed`, and a dry run through `runAuthoredTool` when `testInput` is given. Layout is `@graft/toolbox`'s: `TOOLBOX_DIR = TOOLBOX_MOUNT_PATH`, `draftsDir(agentId) = sandboxPath(draftPath(agentId))`.

## Env

Added: **`GRAFT_SANDBOX_BACKEND`** (`docker | fake`, default `docker`; `fake` refused under `NODE_ENV=production` in `serverEnvIssues`). Consumed but owned by GRA-18: `GRAFT_SANDBOX_IMAGE`/`GRAFT_SANDBOX_NETWORK` (optional, all-or-nothing; absent under `docker` → `sandbox: null`), `GRAFT_TOOLBOX_ROOT`, `GRAFT_PACKAGE_*`. The agent's original defaulted image/network fields were dropped at the merge in favour of GRA-18's pair.

## Other decisions

`@modelcontextprotocol/sdk` 1.30.0, low-level `Server` (dynamic per-agent list with stored JSON Schemas; notification owned by the notifier) over `WebStandardStreamableHTTPServerTransport` (stateful, per session, `handleRequest(Request)` in Hono); `InMemoryTransport` for the primary suite, `StreamableHTTPClientTransport` with `fetch: app.request` for the HTTP-layer suite. Validation is the SDK's own Ajv provider (no new dependency). Sessions bound to the agent at `initialize`; every request re-resolves the token (401 `token_missing` / `token_unknown` / `session_mismatch`). Ledger rows for runs only, so a first-class call leaves exactly one. `allowImportingTsExtensions` in the base tsconfig (same change as GRA-18). Fake sandbox now rewrites sandbox paths in per-process env values (fidelity fix, seam unchanged). Skill renamed `run_published_tool` → `run_tool`, `execute__<connection id>`, `_detached` removed; CONTEXT.md records the `__` separator under *Tool*. Test fixtures for later tickets: `packages/mcp/src/testing/fake-deps.ts` (`createFakeStore`, `createFakeDeps`) and `fake-vendor.ts` (`startFakeVendor`, `generateTestKeys`).
