# Cando → Graft copy inventory

Source: a Cando checkout (pnpm monorepo, read-only). Target: Graft, per `docs/adr/0010`, `0011`, `0013` and `CONTEXT.md`. Written by a read-only research agent on 2026-09-09 and saved by the orchestrator.

Vocabulary map that applies to **every** section (ADR 0011: "copied code must be re-read, not trusted"):

| Cando | Graft |
| --- | --- |
| `organizationId` | drop, or `personId` |
| `agentId` | `agentId` (survives, but it is now "one harness connection", not a tenant's agent row) |
| `appSlug` (one app per connection) | connection + **host set** |
| `chat`, `automation`, `grant`, `member`, `team` | none — delete |
| `CANDO_*` env prefix, `x-cando-*` headers | `GRAFT_*`, `x-graft-*` |
| `CAN-###`, "ADR 00xx" in comments | Graft ADR numbers |

---

## 1. GRA-5 — the proxy, capability token, vault

### Files to copy

| Path | Lines | Purpose |
| --- | --- | --- |
| `packages/proxy/package.json` | 27 | Package manifest; `exports` maps `.` and `./*` straight at `src/*.ts` (no build step) |
| `packages/proxy/README.md` | 177 | States the spin-out boundary and the `ProxyDeps` table; rewrite, do not delete |
| `packages/proxy/tsconfig.json` | 6 | extends `@cando/config/tsconfig.base.json`, `noEmit` |
| `packages/proxy/src/index.ts` | 34 | The package's whole public surface: `createProxyApp`, `SCHEME_CREDENTIAL_FIELDS`, dry-run constants, `AUTH_SCHEMES`, types |
| `packages/proxy/src/types.ts` | 305 | The vocabulary: `ProxyConnection`, `ProxyDeps`, `CapabilityClaims`, `ProxyEvent`, `ProxyOutcome` (25 outcomes), `SchemeRuntime`, `BrokeredCredentialSource` |
| `packages/proxy/src/app.ts` | 736 | The Hono app and the request ladder; `ALL /c/:connectionId(/*)` + `GET /.well-known/jwks.json` |
| `packages/proxy/src/schemes.ts` | 441 | Six scheme plugins (`apply`/`derive`/`headerNames`), incl. OAuth2 client-credentials exchange and Unleashed HMAC |
| `packages/proxy/src/credential-source.ts` | 127 | Where the credential comes from: **custom (vault)** vs **brokered (Pipedream)**; plus `wireCredential` |
| `packages/proxy/src/credential-fields.ts` | 27 | `SCHEME_CREDENTIAL_FIELDS` table; deliberately import-free so a browser bundle can reach it |
| `packages/proxy/src/dry-run.ts` | 135 | `DRY_RUN_HEADER` (`x-cando-dry-run`), `DRY_RUN_PREVIEW_STATUS` = 202, `SAFE_METHODS`, `buildDryRunPreview`, `schemeHeaderNames` |
| `packages/proxy/src/public-host.ts` | 194 | Literal-hostname SSRF table (RFC1918, loopback, `169.254.169.254`, CGNAT, doc ranges, IPv6) |
| `packages/proxy/src/upstream.ts` | 102 | undici fetch with a `dns.lookup` guard that refuses a name resolving to any private address; `PrivateAddressError` |
| `packages/proxy/src/redirects.ts` | 100 | `MAX_REDIRECT_HOPS` = 3, same-host-only hop policy, `scrubReturnedRedirect` |
| `packages/proxy/src/failure.ts` | 288 | `refuse`, `refusalBody` (`{error, reason, message}`), `guardHostDeps` (host errors recorded by class name only) |
| `packages/proxy/src/headers.ts` | 124 | Forwardable request / passthrough response header policy |
| `packages/proxy/src/token.ts` | 47 | `extractToken` (4 positions: `Bearer`, raw `Authorization`, `x-api-key`, `x-cando-token`), `INBOUND_AUTH_HEADERS` |
| `packages/proxy/src/body.ts` | 84 | `declaredLength`, `readCapped` (10 MiB cap) |
| `packages/proxy/src/cache.ts` | 35 | In-process TTL cache for derived credentials (OAuth2 access tokens) |
| `packages/proxy/src/cause-chain.ts` | 70 | `causeChain`, `describeCauseChain`, `hasCauseNamed`; depth 5 |
| `packages/api/src/lib/capability-token.ts` | 254 | Mint/verify EdDSA JWT; `capabilityTokenJwks`; `resolveCapabilityTokenKeys` |
| `packages/api/src/lib/credential-vault.ts` | 235 | AWS Encryption SDK envelope encryption; `CredentialVault`, `EncryptOnlyVault`, KMS + local AES keyrings |
| `packages/api/src/modules/proxy/proxy.deps.ts` | 88 | The host binding: `toProxyConnection`, `createServerProxyDeps` |
| `infrastructure/app/src/capability-token.ts` | 58 | Pulumi `tls.PrivateKey` ED25519 + Secrets Manager version |
| `apps/server/src/index.ts` lines **126–157** | ~30 | The mount: `await resolveCapabilityTokenKeys()` then `app.route("/api/proxy", createProxyApp(createServerProxyDeps({db, log})))`, deliberately **above** CORS and the oRPC catch-all |

**Do not copy** (Pipedream — Graft deletes it, ADR 0001/0010): `packages/api/src/modules/proxy/brokered-registry.ts` (72), `brokered-credentials.ts` (128), `packages/api/src/lib/pipedream.ts` (882).

### Tests to copy

`packages/proxy/src/app.test.ts` (1911), `schemes.test.ts` (489), `failure.test.ts` (373), `credential-source.test.ts` (270), `redirects.test.ts` (182), `dry-run.test.ts` (161), `public-host.test.ts` (130), `upstream.test.ts` (105), `cause-chain.test.ts` (81), `body.test.ts` (64), `token.test.ts` (44), `cache.test.ts` (36). Plus `packages/api/src/lib/capability-token.test.ts` (261), `credential-vault.test.ts` (174), `packages/api/src/modules/proxy/proxy.deps.test.ts` (61) and `proxy.test.ts` (412).

Skip `brokered-registry.test.ts` (52) and `brokered-credentials.test.ts` (155).

### External npm dependencies

| Package | Version | Where declared |
| --- | --- | --- |
| `hono` | `catalog:` → `^4.13.3` | `packages/proxy/package.json` dep; `pnpm-workspace.yaml:15` |
| `undici` | `^7.29.0` | `packages/proxy/package.json` |
| `jose` | `^6.2.4` | `packages/api/package.json` (capability token) |
| `@aws-crypto/client-node` | `^5.0.2` | `packages/api/package.json` (vault) |
| `@types/node` | `catalog:` → `^26.2.0` | dev |
| `typescript` | `catalog:` → `^7` | dev |
| `vitest` | `^4.1.11` | dev |
| `@pulumi/tls`, `@pulumi/aws` | see `infrastructure/app/package.json` | infra only |

### Internal imports that must be cut or replaced

`packages/proxy/**` imports **nothing** from `@cando/api`, `@cando/db` or `@cando/env` — this is the one clean copy in the whole inventory. Everything else:

| File | Import | Provides | Action |
| --- | --- | --- | --- |
| `capability-token.ts:3` | `@cando/env/server` → `env` | `CAPABILITY_TOKEN_PRIVATE_KEY/PUBLIC_KEY` | replace with Graft env |
| `capability-token.ts:4` | `@cando/proxy/types` | `CapabilityClaims`, `JsonWebKeySet`, `TokenVerdict` | keep (subpath is load-bearing — see the file header: importing the index pulls the Hono app into the web type program) |
| `credential-vault.ts:12` | `@cando/env/server` | `CREDENTIAL_KMS_KEY_ARN`, `BETTER_AUTH_SECRET` | replace; `BETTER_AUTH_SECRET` is the local-keyring seed (Graft's console does use Better Auth, so a seed exists, but name it deliberately) |
| `credential-vault.ts:13` | `@cando/proxy/types` | `CredentialFields`, `CredentialScope` | keep |
| `proxy.deps.ts:1` | `@cando/db/repo/connection` | `ConnectionRow`, `findConnectionByIdUnscoped` | rewrite against Graft's connection table |
| `proxy.deps.ts:2` | `@cando/env/server` | `PROXY_FOLLOW_REDIRECTS` | replace |
| `proxy.deps.ts:5` | `../../context` → `ServiceContext` | db handle | replace |
| `proxy.deps.ts:8` | `../../lib/pipedream` | broker client | **delete** |
| `proxy.deps.ts:9-10` | `./brokered-credentials`, `./brokered-registry` | broker seam | **delete** |
| `apps/server/src/index.ts:57,61` | `@cando/api/modules/proxy/proxy.deps`, `@cando/proxy` | mount | keep shape |

### Environment variables read

`CAPABILITY_TOKEN_PRIVATE_KEY` (PKCS#8 PEM, optional, secret), `CAPABILITY_TOKEN_PUBLIC_KEY` (SPKI PEM, optional), `CREDENTIAL_KMS_KEY_ARN` (**required**; `local` or `arn:aws:kms:…:key/…`, `local` refused under `NODE_ENV=production` at `packages/env/src/server.ts:652`), `BETTER_AUTH_SECRET` (local-keyring seed), `PROXY_PUBLIC_URL` (optional; defaults to `${BETTER_AUTH_URL}/api/proxy`, `server.ts:257-262`), `PROXY_FOLLOW_REDIRECTS` (`z.stringbool().default(false)`, `server.ts:798`), `SANDBOX_EGRESS_ALLOWLIST` (comma-separated hostnames, `*.` allowed; default `[proxy hostname, registry.npmjs.org]`, `server.ts:266-345`), `SANDBOX_REGION`, `TOOLBOX_BACKUP_PREFIX`.

Note `withDerivedDefaults` (`server.ts:326-346`): the allowlist default derives from the **resolved** `PROXY_PUBLIC_URL`, not `BETTER_AUTH_URL`. Copy that ordering.

### Cando-specific coupling to remove

- Every file header names CAN tickets: CAN-463, 465, 466, 470, 473, 484, 486, 490, 501, 502, 503, 506, 509, 513, 516, 519, and ADRs 0018/0019/0025/0026/0027/0029. Repoint per ADR 0011.
- `organizationId` is on `ProxyConnection`, on `CredentialScope` (it is part of the **AWS encryption context**, `credential-vault.ts:88-94` — changing it invalidates every existing ciphertext, which is fine for a new repo), on `ProxyEvent`, and is the `org` JWT claim.
- `appSlug` / the `app_mismatch` refusal / `claims.app`: **this is the change GRA-5 must make.** Today one connection = one `appSlug` = one `baseUrl`, and `resolveTarget` (`app.ts:430-443`) does `new URL(baseUrl)` then assigns `pathname = base.pathname + vendorPath` and asserts `url.host === base.host`. Graft needs a host segment against a **declared host set** per connection (ADR 0010): the route gains `/h/<host>/`, `ProxyConnection.baseUrl: string | null` becomes a primary plus a host set, and the `url.host !== base.host` guard becomes membership in that set. `isPublicHost` and the undici resolver guard stay unchanged and still run per hop.
- `kind: "pipedream" | "custom"`, `BrokeredDefinition`, `BrokeredCredentialSource`, `ProxyDeps.brokered`, and the outcomes `brokered_not_supported`, `brokered_app_not_in_registry`, `brokered_credential_unavailable` all go. `credentialSource()` collapses to its `custom` branch (`credential-source.ts:38-66`).
- `UNLEASHED_CLIENT_TYPE = "cando/agent"` (`schemes.ts:168`) and the `unleashed_hmac` scheme exist for one Cando customer; keep the scheme as the worked example of a signing recipe but rename the constant.
- `x-cando-token`, `x-cando-dry-run`, `CONTEXT_PURPOSE = "cando:connection-credential"`, `keyNamespace: "cando-local"`, JWT `iss: "cando"`.

### Notes

- The proxy is mounted **before** `cors()` on purpose: Hono's `cors()` answers every `OPTIONS` itself, which would stop a vendor's own preflight reaching the vendor (`apps/server/src/index.ts:128-146`).
- `DerivedCredentialCache.get` is **synchronous**, so a Redis-backed cache is not a drop-in (`types.ts`, `SchemeRuntime`).
- ADR 0013 wants a `node_modules` per published version; nothing in the proxy needs changing for that, but `SANDBOX_EGRESS_ALLOWLIST`'s npm-registry default must move to the *install* step only.

---

## 2. GRA-3 — the check and the runner

### Files to copy

| Path | Lines | Purpose |
| --- | --- | --- |
| `packages/api/src/modules/ai/module-check.core.ts` | 1342 | The check itself: virtual TS program, `/module` + `/cando/contract.d.ts` + `/cando/runtime.d.ts` + wrapper, `castDefaultExport`, `inputTypeFromSchema`, 17 refusal rules, 5 advice rules |
| `packages/api/src/modules/ai/module-check.ts` | 200 | The budget door: 256 KiB / 10 s, `worker.terminate()`, `readModuleSources`, `workerUrl()` |
| `packages/api/src/modules/ai/module-check.worker.ts` | 15 | Worker entry; the one file that imports a sibling with a literal `.ts` extension |
| `packages/api/src/modules/sandbox/runner.mjs` | 416 | The runner seeded into the sandbox; header is the module contract |
| `packages/api/src/modules/sandbox/runner-source.ts` | 50 | `RUNNER_DIR = "/cando"`, `RUNNER_PATH = "/cando/runner.mjs"`, `loadRunnerSource()`, `runnerFiles()` |
| `packages/api/src/modules/sandbox/skills.ts` | 138 | `loadSkills()`; `SKILLS_SOURCE_DIR = resolve(process.cwd(), "../../packages/api/src/skills")` |
| `packages/api/src/skills/authoring-a-tool/SKILL.md` | 302 | The authoring skill |

Also worth copying as prior art: `packages/api/src/skills/connecting-an-app/SKILL.md`, `what-we-cannot-do-yet/SKILL.md`.

### Tests to copy

`packages/api/src/modules/ai/module-check.test.ts` (696), `packages/api/src/modules/sandbox/runner.test.ts` (718 — spawns real Node against `runner.mjs`), `skills.test.ts` (225).

### External npm dependencies

`typescript6` = `npm:typescript@~6.0.3` (`packages/api/package.json:44`). **This alias is the trick**: the catalog pins `typescript: ^7` (`pnpm-workspace.yaml:11`), and TS 7 is the Go-native compiler whose npm package ships only `tsc` — no `createProgram`/`createSourceFile`. So `module-check.core.ts:4` does `import ts from "typescript6"` while the repo's own `tsc` stays on 7. Copy the alias verbatim. Runner and worker need nothing else.

### Internal imports that must be cut or replaced

| File:line | Import | Provides | Action |
| --- | --- | --- | --- |
| `module-check.core.ts` | *(none beyond `node:module`, `node:path`, `typescript6`)* | — | copy as-is; the file is deliberately `@cando`-free because Node resolves the worker's graph natively |
| `module-check.ts:4` | `../sandbox/sandbox.deps` → `SandboxFile`, `SandboxHandle` | seam types | keep, retarget to Graft's seam |
| `module-check.ts:7` | `../sandbox/sandbox.service` → `authoredToolEntryOf` | entry resolution order | keep (pure helper) |
| `module-check.ts:8` | `./ai.errors` → `errorMessage` | error flattening | inline or copy `ai.errors.ts` |
| `runner-source.ts:4` | `./sandbox.deps` → `SandboxFile` | seam type | keep |
| `runner.mjs` | none | — | pure Node |

### Environment variables read

Runner (inside the sandbox): `CANDO_PROXY_URL`, `CANDO_CONNECTION`, `CANDO_TOKEN`, `CANDO_TIMEOUT_MS` (default 60 000), `CANDO_RESULT_PATH`, `CANDO_DRY_RUN`. The runner reads all of these once and then **deletes every `CANDO_*` key from `process.env` before importing the module** (`runner.mjs:26-33`). Also relies on `NODE_USE_ENV_PROXY=1` being set at process start by the caller (`authoring-tools.ts:152`) — the runner cannot set it itself.

Host side: none in `module-check.*`; `runner-source.ts` reads `process.cwd()`.

### The module contract (record this exactly)

- Entry: a directory containing `index.ts` (first) or `index.mjs` (second), or the file itself. `AUTHORED_TOOL_ENTRIES` in `sandbox.service.ts:587`.
- Default export: `async (input: Input, ctx: Context) => unknown`, ES module.
- `Input`: generated from the tool's JSON Schema; `any` when no schema.
- `Context`: `{ fetch(path: string, init?: RequestInit): Promise<Response> }` — `CONTEXT_DECLARATION`, `module-check.core.ts:~100`. **Discrepancy to fix in Graft**: the actual runtime `ctx` is `Object.freeze({ fetch, connection })` (`runner.mjs:~330`), so `ctx.connection` exists at run time but is not declared to the checker. Graft adds `proxyBase(host?)` and `proxyKey` (see modern-inventory.md, orchestrator's decisions).
- `ctx.fetch(path, init)` prepends `${PROXY_URL}/c/${CONNECTION}/` and sets `Authorization: Bearer <token>`. Absolute URLs and paths that escape `/c/<connection>/` are refused before any request is made.
- stdin is JSON (empty ⇒ `{}`); stdout is exactly the JSON result.
- Erasable TypeScript syntax only (Node 24 type stripping): no `enum`, `namespace`, parameter properties, decorators.

### Exit codes

| Code | Constant | Meaning |
| --- | --- | --- |
| 0 | `EXIT_OK` | result on stdout (or `__CANDO_RESULT__:<path>` when detached) |
| 1 | `EXIT_THREW` | module threw; message + stack tail (4 000 chars) on stderr |
| 2 | `EXIT_TIMEOUT` | did not settle within `CANDO_TIMEOUT_MS`; also `EXIT_RUNNER_TIMEOUT` in `sandbox.service.ts:699` |
| 64 | `EXIT_USAGE` | no module path, unresolvable module, or unparseable stdin |
| 66 | `EXIT_MODULE_MISSING` | `sandbox.service.ts:697` — set by the wrapper shell script, the one code that triggers a toolbox remount + retry |

A dry run exits **0** with the report whether or not the module threw; only a timeout keeps its own code.

### Dry-run report shape

`runner.mjs:390-414`, mirrored as `DryRunReport` in `authored-tool.service.ts:110-153`:

```
{ dryRun: true, passed, reads[], writesPreviewed[], writesRefused[],
  omitted?, moduleResult? | moduleError?,
  verified: { reads, writeRequests },
  unverified: string[] }
```

`passed = every read < 400 && writesRefused.length === 0 && !(threw before any write was intercepted)`. Caps: `MAX_RECORDED_CALLS` 50, `MAX_RECORDED_BODY_CHARS` 4 000. A preview arrives as HTTP **202** with `x-cando-dry-run: intercepted`.

### Cando-specific coupling to remove

CAN-464, 468, 471, 472, 482, 484, 487, 489, 503, 509; ADR 0025/0026/0029. `CANDO_*` env prefix throughout `runner.mjs` and the checker's `execute-environment` rule (which refuses a module naming `CANDO_PROXY_URL`/`CANDO_CONNECTION`/`CANDO_TOKEN` — the names must change together). `SKILL.md` names `request_connection`, `request_custom_app`, "the member", "a card in the thread", "the catalogue" — all Cando console/tenancy concepts; Graft's equivalents are the handoff URL and the console (ADR 0006).

### Notes

- `RUNNER_SOURCE_PATH` and `SKILLS_SOURCE_DIR` are both `resolve(process.cwd(), "../../packages/api/src/…")` and depend on `WORKDIR /app/apps/<app>`. Fragile; Graft should decide this deliberately.
- `allowImportingTsExtensions: true` in `packages/api/tsconfig.json` exists solely so `tsc` accepts `module-check.worker.ts`'s `./module-check.core.ts` import.
- Production needs a **second bundle entry** `dist/module-check.worker.mjs` in each app's `tsdown.config.ts`.
- ADR 0013 changes the checker: today `import-outside-module` and "no npm packages" are absolute. Graft must allow imports resolving into the version's own `node_modules`, and add ADR 0010's SDK-binding rule (`ctx.proxyKey` as the credential argument + `ctx.proxyBase(...)` as the base), which does not exist in Cando.

---

## 3. GRA-4 / GRA-18 — the sandbox seam and the toolbox/publish

### Files to copy

| Path | Lines | Purpose |
| --- | --- | --- |
| `packages/api/src/modules/sandbox/sandbox.deps.ts` | 520 | **The seam.** `SandboxHandle`, `SandboxDeps`, `wrapSandboxInstance` (Blaxel → seam), `toSandboxCreateConfiguration`, `defaultSandboxDeps` |
| `packages/api/src/modules/sandbox/sandbox.service.ts` | 1036 | Lifecycle + `runAuthoredTool`, `publishToolVersion`, `startDetachedProcess`, `pollDetachedProcess`, `draftsDir`, `remountToolbox` |
| `packages/api/src/modules/sandbox/toolbox-backup.ts` | 264 | Async, best-effort, write-only S3 copy of a published version directory |
| `packages/api/src/modules/sandbox/sandbox.sweep.ts` | 430 | Pure sweep rules: name patterns, region refusals, argv parsing, report rendering |
| `apps/server/src/scripts/sweep-sandboxes.ts` | 66 | CLI entry (`pnpm --filter server sandbox:sweep -- --region us-pdx-1 [--delete]`) |
| `packages/api/src/modules/ai/authored-tool.service.ts` | 464 | `publishAuthoredTool`, `invokeAuthoredTool`, `dryRunAuthoredTool`, `readDryRunReport`, `boundResult` |
| `packages/api/src/modules/ai/authored-tools.ts` | 912 | Transport: `check_tool`, `publish_tool`, `run_published_tool`, `read_tool_source`, plus the first-class mount |
| `packages/api/src/modules/ai/authoring-tools.ts` | 781 | `write_file`, `read_file`, `run_command`, `wait_for_process`, `read_web_page` |
| `packages/api/src/modules/ai/execute-tools.ts` | 290 | `runWithCapability` — the mint→run→tally sequence; `tokenTtlFor`; `CANDO_DRY_RUN_ENV` |

### Tests to copy

`sandbox.service.test.ts` (1876), `sandbox.deps.test.ts` (414), `sandbox.sweep.test.ts` (500), `toolbox-backup.test.ts` (357), `authored-tools.test.ts` (2049), `authoring-tools.test.ts` (912), `authored-tool.service.test.ts` (674), `execute-tools.test.ts` (548).

### External npm dependencies

`@blaxel/core` `^0.3.13`; `@aws-sdk/client-s3` `^3.1120.0` (backup store, via the attachment adapter); `ai` `catalog:` → `^7.0.83` (`dynamicTool`, `jsonSchema`, `ToolSet`); `zod` `catalog:` → `^4.4.3`; `evlog` `^2.27.1` (`toolbox-backup.ts`); `tsx` (the sweep script's runner).

### The seam's verbs (record these signatures)

`SandboxHandle` — `sandbox.deps.ts:110-128`:

| Verb | Signature |
| --- | --- |
| `writeTree` | `(files: SandboxFile[], destination: string) => Promise<void>` |
| `exec` | `(command: string, options?: ExecOptions) => Promise<string>` — combined output, trimmed |
| `execDetached` | `(command: string, options: ExecDetachedOptions) => Promise<string>` — returns the process name |
| `waitForProcess` | `(name: string, options: WaitForProcessOptions) => Promise<SandboxProcessResult>` |
| `mountDrive` | `(args: { driveName, mountPath, remount? }) => Promise<void>` |
| `downloadDirectory` | `(path: string) => Promise<SandboxFile[]>` — recursive, relative paths, same shape `writeTree` takes |
| `ls` | `(path: string) => Promise<string[]>` |
| `read` | `(path: string) => Promise<string>` |

`SandboxDeps` — `sandbox.deps.ts:170-217`: `ensure(EnsureSandboxArgs) => Promise<{handle, existed}>`, `setExpiry({name, ttl: string|null}) => Promise<void>`, `ensureDrive({name, region}) => Promise<void>`, `listSandboxes() => Promise<SandboxSummary[]>`, `deleteSandbox(name) => Promise<void>`.

Supporting shapes: `ExecOptions { workingDir?, timeoutSeconds? (default 30, Blaxel caps sync at 60), env?: Record<string,string> }` — **the per-process `env` is what carries the capability token**, never the sandbox's creation-time environment. `ExecDetachedOptions { name, workingDir?, env?, timeoutSeconds? }`. `WaitForProcessOptions { maxWaitSeconds, pollIntervalMs? }`. `SandboxProcessResult { status: "running"|"completed"|"failed"|"killed"|"stopped", exitCode: number|null, logs, stdout?, stderr? }` — `exitCode` is `null` while running because Blaxel reports `0` for an unfinished process. `SandboxEgress { firewallRulesets, allowedDomains }` — two lists because only the ruleset enforces.

Constants: `SANDBOX_IMAGE = "blaxel/node:latest"`, `SKILLS_DIR = "/skills"`, `TOOLBOX_DIR = "/tools"`, `TOOLBOX_DRAFTS_DIR = "/tools/.drafts"`, `draftsDir(chatId) = "/tools/.drafts/<sha256 digest>"`, `RUN_SCRATCH_DIR = "/tmp/cando-runs"`, `SANDBOX_FIREWALL_RULESETS = ["proxy"]`, memory 2048 MB, TTL `1h`.

`runAuthoredTool(handle, { agentId, modulePath, input, env, timeoutSeconds, detached? })` (`sandbox.service.ts:879`): writes the input to a scratch file (not argv — argument limits), shell-guards the module's presence, runs `node /cando/runner.mjs <module> < input 2> stderrfile`, separates stderr with a marker and a bounded tail, and on `EXIT_MODULE_MISSING` **remounts the toolbox once and retries**.

### Internal imports that must be cut or replaced

| File:line | Import | Provides | Action |
| --- | --- | --- | --- |
| `sandbox.deps.ts:4` | `@cando/db/repo/automation` → `listAutomationSandboxOwners` | sweep owners | delete (no automations in Graft) |
| `sandbox.deps.ts:5` | `@cando/db/repo/lease` → `acquire/releaseAutomationLease` | run-in-flight guard | delete |
| `sandbox.deps.ts:6` | `@cando/env/server` | `SANDBOX_REGION`, `TOOLBOX_BACKUP_PREFIX` | replace |
| `sandbox.deps.ts:8` | `../attachment/attachment.deps` → `defaultAttachmentDeps` | S3/local blob store | replace with a Graft store or inline an S3 adapter |
| `sandbox.service.ts:3,5,6,7` | `@cando/env/server`, `../../context`, `../../lib/errors`, `../../lib/lease` | env, db ctx, `describeCauseChain`, `holdAutomationLease` | replace; the lease is automation-only |
| `sandbox.sweep.ts:1,2,4` | `@cando/db/repo/scope` → `AgentScope`; `@cando/env/server` → `BLAXEL_REGION`; `../../lib/lease` | tenancy scope, region regex, lease | drop `AgentScope`, keep the regex |
| `toolbox-backup.ts:1` | `@cando/db/repo/scope` → `AgentScope` | `{organizationId, agentId}` | replace with person/agent |
| `authored-tool.service.ts:1,4,5` | `@cando/db/repo/scope`, `../../lib/mcp-tools` → `ToolInvocation`, `../../lib/tool-names` → `EXECUTE_TOOL`, `xServerName` | scope, usage ledger, `x-<app>__` naming | rewrite; the `x-` server naming is Pipedream-MCP-shaped |
| `authored-tools.ts:3,7,13,23,24` | `@cando/db/repo/scope`, `../../context`, `../../lib/mcp-tools`, `../../lib/tool-names`, `../agent/agent.tools` → `AgentToolKey`, `AgentToolMap` | the member's tool catalogue and gate | rewrite against Graft's meta-tools |
| `authoring-tools.ts:6,7,8` | `../agent/agent.tools`, `../sandbox/runner-source`, `../sandbox/sandbox.deps` | catalogue key, `RUNNER_PATH`, seam | keep the last two |
| `execute-tools.ts:3,9,10,13,14` | `../../lib/capability-token`, `../../lib/mcp-tools`, `../../lib/tool-names`, `../sandbox/sandbox.service` → `ToolboxMount`, `./ai.deps` | mint cap, gate types | keep the mint; cut the gate/ledger |
| `sweep-sandboxes.ts:1,4,5` | `@cando/api/context`, `@cando/db`, `@cando/env/server` | db + env | replace |

Biome enforces some of this already: `packages/api/src/modules/**/*.service.ts` may not import `@cando/db` (only `@cando/db/repo/*`) nor another module's `*.service` (`biome.json:105-133`).

### Environment variables read

`SANDBOX_REGION` (default `us-was-1`), `SANDBOX_EGRESS_ALLOWLIST`, `TOOLBOX_BACKUP_PREFIX` (default `toolbox/`), `PROXY_PUBLIC_URL` (bound as `deps.proxyUrl` in `ai.deps.ts:895` and handed to the process as `CANDO_PROXY_URL`), `ATTACHMENTS_BUCKET` (indirect, via the attachment adapter), `BL_API_KEY` / `BL_WORKSPACE` (read by `@blaxel/core` itself).

### Cando-specific coupling to remove

- `AgentScope` = `{organizationId, agentId}` runs through the sweep, the backup and both authored-tool files.
- Chat/automation duality: `chatSandboxName`, `automationSandboxName`, `ensureChatSandbox`, `ensureAutomationSandbox`, `makeChatSandboxPermanent`, `SWEEP_LEASE_*`, the whole lease mechanism, and `draftsDir(chatId)` (Graft has no chats — key drafts by acquire-job id).
- The "first-class mount" in `authored-tools.ts` mounts each authored tool under a Pipedream-style `x-<appSlug>__<tool>` server so Cando's grant gate, disclosure and usage ledger see it. Graft's equivalent is `promote`/`demote` + `tools/list_changed` (CONTEXT.md); the whole mount block is a rewrite, not a copy.
- `connectionToolApproval`, "the card", `ToolInvocation` tallies, credits/pricing.
- CAN-51, 187, 464, 468, 469, 471, 472, 475, 482, 487, 489, 501, 503, 509; ADR 0004/0018/0019/0025/0026/0027/0029.
- The sweep script's premise (a stale `us-pdx-1` region) is a Cando historical artefact; copy `sandbox.sweep.ts`'s *shape* and drop the specific region story.

### Notes

- `sandbox.deps.ts`'s opening comment is the reason to copy it verbatim: "re-pointing this file is the whole migration." Graft needs a second backing (Docker, ADR 0002/0013) behind the same interface — every verb above must be implementable by a short-lived container plus a bind mount. `mountDrive`/`ensureDrive` and `setExpiry` are the two that do not map cleanly.
- Fork/snapshot is deliberately **not** on the seam.
- ADR 0013 adds a verb the seam lacks: an install step that alone may reach the registry.
- Backup bounds: `TOOLBOX_BACKUP_MAX_FILE_BYTES` / `MAX_TOTAL_BYTES`; exceeding either yields outcome `partial`; text-only (a binary would not survive, and the runner would not load it).

---

## 4. GRA-31 — evals

### Files to copy

| Path | Lines | Purpose |
| --- | --- | --- |
| `packages/evals/src/harness.ts` | 592 | Runs the **real** agent (`streamChat`) with persistence, tenancy and sandbox faked; records `ToolCall`s with arguments |
| `packages/evals/src/scenarios.ts` | 682 | ~20 named scenarios, each a prompt + a scorer list |
| `packages/evals/src/scorers.ts` | 748 | 21 deterministic scorers; free, instant, no model |
| `packages/evals/src/judges.ts` | 650 | 15 `LLMClassifierFromTemplate` judges; constructing the module builds an OpenAI client |
| `packages/evals/src/demo-vendor.ts` | 351 | Loopback fake vendor (`GET /items`, `POST /orders`, docs page) **plus a proxy stand-in** that verifies the token, injects the key, forwards, and records which tool each token was minted for |
| `packages/evals/src/demo-world.ts` | 330 | Wires vendor + disk sandbox + in-memory mint + in-memory authored-tool ports into production's shape |
| `packages/evals/src/disk-sandbox.ts` | 255 | `SandboxHandle` over a temp directory; maps `/tools`, `/cando`, `/skills`, `/tmp` under a root and runs commands via `sh` with a clean env |
| `packages/evals/src/agent.eval.ts` | 118 | The suite; assertions deliberately weak, the **report** is the point; headline is the weakest score, not the mean |
| `packages/evals/src/calibration.eval.ts` | 440 | Grades the judges against deliberately good/bad exemplars |
| `packages/evals/vitest.eval.config.ts` | ~95 | Loads `apps/server/.env`, pins `BL_MODEL`/`AI_REASONING_EFFORT`, `include: src/**/*.eval.ts`, sequential, 180 s timeout |
| `packages/evals/vitest.config.ts`, `tsconfig.json`, `package.json` | — | Config |

### Tests to copy

`demo-world.test.ts` (357), `scorers.test.ts` (1172), `disk-sandbox.test.ts` (156), `scenarios.test.ts` (34 — asserts the module loads with **no** server environment).

### How it is run

`pnpm --filter @cando/evals eval` → `vitest run --config vitest.eval.config.ts`. Named `*.eval.ts`, not `*.test.ts`, so `pnpm test` never picks them up. Not in CI; run by hand before a release and whenever a skill's claims change. `calibration.eval.ts` needs `OPENAI_API_KEY` and nothing else — a property maintained by using only `import type` from `harness.ts`; a value import would drag `packages/env` in and cost it that independence.

### External npm dependencies

`autoevals` `^0.3.0`, `openai` `^6.49.0`, `ai` `catalog:` → `^7.0.83`, `dotenv` `catalog:` → `^17.4.2`, `vitest` `^4.1.11`, `typescript` `catalog:`.

### Internal imports that must be cut or replaced

`harness.ts` imports eleven `@cando/api` paths: `lib/superseded-apps` (`currentAppSlug`), `modules/agent/agent.tools` (`agentToolDefaults`), `modules/ai/ai.deps` (`AiDeps`, `PreparedSkills`, `defaultAiDeps`, `activeModelId`, `providerOptionsFor`), `modules/ai/ai.service` (`streamChat`), `modules/sandbox/runner-source`, `modules/sandbox/sandbox.deps`, `modules/sandbox/sandbox.service` (`SKILLS_DIR`), `modules/sandbox/skills`, `modules/schedule/schedule.intent`. `scenarios.ts` adds `lib/run-opener`, `modules/event/event.message`, `modules/schedule/schedule.intent`. `scorers.ts` adds `lib/tool-names`, `modules/ai/identity` (`IDENTITY`) and — cleanly — `@cando/proxy` (`isSafeMethod`). `judges.ts` adds `modules/ai/identity` (`HOUSE_STYLE`). `demo-world.ts` adds `lib/mcp-tools`, `lib/tool-names`, `modules/ai/ai.deps`, `modules/ai/execute-tools`, `modules/ai/module-check`, `modules/ai/web-page`, `modules/sandbox/sandbox.service`. `disk-sandbox.ts` imports only `modules/sandbox/sandbox.deps` types. `demo-vendor.ts` imports only `@cando/proxy`.

### Environment variables read

`OPENAI_API_KEY` (judges), `BL_MODEL` and `AI_REASONING_EFFORT` (**overwritten** by the config to `gpt-5-6-sol` / `medium`, which must track `infrastructure/app/src/ecs.ts`), plus everything `apps/server/.env` feeds `packages/env` for `agent.eval.ts`.

### Cando-specific coupling to remove

Roughly two thirds of the scenarios are about **schedules, events and automations** (`a-weekday-schedule-is-affirmed`, `an-event-trigger-is-affirmed`, `an-in-cando-event-is-still-declined`, `a-tied-automation-is-updated-in-place`, the three cadence scenarios) and the matching scorers (`scheduledInterval`, `scheduledBothCadences`, `noUnrequestedInterval`, `retimedSchedulesInPlace`, `ranExistingAutomation`, `foundTheAutomationByListing`) and judges (`intervalFloorHonesty`, `scheduleAgreedFirst`, `updatesInPlace`, `findsByName`, `servesTheBrief`). None of that exists in Graft.

**Copy this subset**, which is the acquire loop and is exactly what GRA-31 wants: `demo-vendor.ts`, `demo-world.ts`, `disk-sandbox.ts` whole, plus scorers `readTheDocsFirst`, `provedWithReadsBeforePublishing`, `publishedBeforeTheFirstWrite`, `wroteThroughThePublishedTool`, `dryRanBeforeAsking`, `moduleHoldsNoSecret`, `placedTheOrder`, `completed`, `readSkill`, and the `AuthoringEvidence` shape they read. `HOUSE_STYLE`/`IDENTITY`, `followsHouseStyle`, `keepsInstructionsPrivate`, `toneAdherence` and `declinesToLeak` are Cando's voice — keep the mechanism, rewrite the text. Tickets: CAN-13, 92, 96, 105, 158, 288, 474, 506.

### Notes

- `demo-vendor.ts` is the model for Graft: it takes `DRY_RUN_HEADER`, `DRY_RUN_PREVIEW_STATUS` and `isSafeMethod` from `@cando/proxy` so the stand-in's dry-run rule **is** the proxy's rather than a copy. Preserve that.
- `disk-sandbox.ts` is Graft's Docker-backing prototype: it already implements the whole `SandboxHandle` against a directory. Read it before writing the Docker backing.
- The comment block at the top of `vitest.eval.config.ts` records four occasions on which the suite asserted a boundary the product had outgrown. Worth keeping.

---

## 5. Conventions for the scaffold agent

**Biome** (`biome.json`, `@biomejs/biome` `^2.5.11`): formatter on, `indentStyle: "space"`, `indentWidth: 2`, `lineWidth: 100`, `quoteStyle: "double"`; `assist.actions.source.organizeImports: "on"`; `linter.rules.recommended: true` plus `correctness.useExhaustiveDependencies: "info"`, `suspicious.noFocusedTests: "error"`, and ten `style` rules set to error (`noParameterAssign`, `useAsConstAssertion`, `useDefaultParameterLast`, `useEnumInitializers`, `useSelfClosingElements`, `useSingleVarDeclarator`, `noUnusedTemplateLiteral`, `useNumberNamespace`, `noInferrableTypes`, `noUselessElse`). Scripts: `check` = `biome check --write .`, `lint` = `biome ci .`.

The `overrides` are architecture enforced as lint, and Graft should port the pattern:
- `**/*.router.ts` may not import `@cando/db` at all.
- `**/*.service.ts` may not import `@cando/db` or `@cando/db/schema/**` (only `@cando/db/repo/*`), and may not import another module's `*.service` — "services are leaves".
- `packages/api/src/lib/**` may not import from `modules/**`.
- `apps/web/src/**` may not import `node:*` or `@cando/proxy`.

**tsconfig** (`packages/config/tsconfig.base.json`, package `@cando/config`, private, no build): `target`/`module` `ESNext`, `moduleResolution: "bundler"`, `lib: ["ESNext"]`, `verbatimModuleSyntax`, `strict`, `skipLibCheck`, `resolveJsonModule`, `allowSyntheticDefaultImports`, `esModuleInterop`, `forceConsistentCasingInFileNames`, `isolatedModules`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `types: ["node"]`. Each package: `{ extends, compilerOptions: { noEmit: true }, include: ["src/**/*.ts"], exclude: ["dist"] }`. `packages/api` adds `allowImportingTsExtensions: true` (needed by the check worker).

**pnpm catalog** (`pnpm-workspace.yaml`), the entries Graft needs: `typescript: ^7`, `@types/node: ^26.2.0`, `hono: ^4.13.3`, `zod: ^4.4.3`, `dotenv: ^17.4.2`, `ai: ^7.0.83`, `@orpc/server|openapi|zod|client: ^1.15.0`. Not catalogued but pinned per package: `vitest ^4.1.11`, `@biomejs/biome ^2.5.11`, `turbo ^2.10.12`, `jose ^6.2.4`, `undici ^7.29.0`, `typescript6 = npm:typescript@~6.0.3`. **No drizzle entry in the catalog** — check `packages/db/package.json` for the drizzle versions if Graft needs them.

**Node / package manager**: Node **24** (`node:24-slim` in both Dockerfiles; `node-version: 24` in `.github/workflows/ci.yml` and `deploy.yml`), `packageManager: "pnpm@10.6.1"`, `"type": "module"` everywhere, Turborepo for orchestration. Workspace globs `apps/*`, `packages/*`, `infrastructure/*`. Packages are consumed as raw TypeScript — `exports: { ".": { "default": "./src/index.ts" }, "./*": { "default": "./src/*.ts" } }` with no build step — which is why the subpath imports above resolve.

---

### Five biggest coupling problems the copy will face

1. **One connection = one `appSlug` = one `baseUrl` is baked into the token, the row, the refusals and the URL builder.** `resolveTarget` (`packages/proxy/src/app.ts:430-443`) pins to a single origin, the JWT carries an `app` claim, and `app_mismatch` is a first-class outcome. ADR 0010's host set with a host segment in the path touches the route, `ProxyConnection`, the claims, the checker's SDK rule and every `app.test.ts` case.
2. **Tenancy leaks into cryptography, not just types.** `organizationId` is half of `CredentialScope` and therefore part of the AWS encryption context (`credential-vault.ts:88-94`) and the `org` JWT claim; `AgentScope = {organizationId, agentId}` threads through the sweep, the backup and both authored-tool files. Renaming it is a schema, a claim and a ciphertext-compatibility decision at once.
3. **Pipedream is not confined to one file.** The broker seam is in `@cando/proxy`'s own type surface (`ProxyDeps.brokered`, `BrokeredDefinition`, `ProxyConnection.kind`), in three `ProxyOutcome` words, and in `credentialSource`'s two-branch structure — so deleting the broker edits the "clean" package, not just `packages/api/src/modules/proxy/`.
4. **`authored-tools.ts` (912 lines) is a transport for Cando's grant gate, approval cards, `x-<app>__` MCP server naming and usage ledger, none of which exist in Graft.** The service beneath it (`authored-tool.service.ts`) copies well; the tool layer above it is a rewrite against `acquire`/`promote`/`run_tool`, and `authored-tools.test.ts` (2049 lines) goes with it.
5. **The runner, the checker and the skill agree on the `CANDO_*` names, and ADR 0013 breaks their shared assumption.** `runner.mjs` deletes `CANDO_*` before import, the checker's `execute-environment` rule refuses a module that names those three variables, and `SKILL.md` teaches the same three — rename in one place and the check silently stops enforcing. Separately, all three currently state "no npm packages, no imports outside the module", which ADR 0013's per-version `node_modules` and ADR 0010's SDK rebinding directly contradict.
