# GRA-18 report (publish writes a version and vendors its packages under the policy), merged as PR #8

Saved by the orchestrator from the implementing agent's report, 2026-09-09; the body is the PR's.

Closes GRA-18 — https://linear.app/get-modern/issue/GRA-18/publish-writes-a-version-vendors-its-packages-under-the-policy-and

## What

Two packages and the wiring around them (GRA-1, "The check, the runner and the toolbox"; ADR 0002, ADR 0009, ADR 0010, ADR 0013).

**`@graft/toolbox`** — the toolbox storage seam and its filesystem backing. `ToolboxStore` is `readTree`, `writeTree`, `read`, `list`, `exists`, `remove` over a toolbox id and a toolbox-relative path; `remove` accepts a draft and refuses everything else, so nothing under `tools/` can be deleted through the seam (ADR 0009). `ToolboxMirror` is `mirrorVersion(toolboxId, versionPath)`; the backing here records the call and copies nothing, standing where the S3 mirror will (GRA-20). Layout: `tools/<vendor>/<name>/v<N>` for versions, `.drafts/<jobId>` for drafts, one directory per toolbox id under `GRAFT_TOOLBOX_ROOT`; the toolbox id is the person's id. A store conformance suite runs against the backing.

**`@graft/publish`** — `publishToolVersion(deps, args)`: read the draft through the store; refuse a lockfile, an `.npmrc` or a `node_modules` in it; read `package.json` for `dependencies` and refuse any other dependency section; run `@graft/check` with those dependencies and refuse on its refusals; put every declared package to the **package policy** (exact version; the allowlist of official vendor SDKs, or npm provenance plus ≥ 90 days of age and ≥ 1000 weekly downloads, both configurable) and refuse with a diagnostic naming the package and the rule, all failing packages at once; write `v<N>`; when packages are declared, run the sandbox backend's `install` (GRA-4's contract) and hash the lockfile; record the version row (path, source hash, lockfile hash, check output, `writes_involved`), create or update the tool row with the check's annotations and move the pointer — `@graft/core`'s one transaction; fire the mirror off the path. `evaluatePackage` is pure. `PackageMetadataSource` has a fake and an npm registry backing (`registry.npmjs.org` for `time.created` and `dist.attestations`, `api.npmjs.org` for last week's downloads), used only on the server at publish time.

**`@graft/core`** gains `nextVersionNumber` and `validateToolDefinition`; `addToolVersion`, `moveToolPointer`, `listToolVersions` and the row-level `publishToolVersion` already existed and are used rather than duplicated.

**`@graft/sandbox-docker`** gains one option, `toolboxHostRoot`: with it every toolbox volume is a bind of `<root>/<toolboxId>`, which is how the server's store and a sandbox's mount become one tree. The seam is unchanged. `packages/toolbox/README.md` documents how the two meet in tests (the fake's `toolboxRoot`), the self-hosted form (the bind) and the hosted form (the mirror).

**`@graft/env`**: `GRAFT_TOOLBOX_ROOT` (default `./.graft/toolboxes`), `GRAFT_PACKAGE_MIN_AGE_DAYS` (90), `GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS` (1000), `GRAFT_PACKAGE_ALLOWLIST` (extra names or `@scope/*`), and the all-or-nothing `GRAFT_SANDBOX_IMAGE`/`GRAFT_SANDBOX_NETWORK` pair.

**`apps/server`**: `pnpm --filter @graft/server publish-fixture` publishes a directory into a person's toolbox by hand — the real database, the filesystem store, the Docker install when the pair is set. No HTTP route; GRA-19 exposes `publish_tool` over MCP.

## Decisions

- **GRA-11's determinism gate is satisfied by construction, not landed.** The gate exists for a manifest read by *executing* the module (executor.sh's collect). Graft's publish never executes the module: description and schema are the caller's arguments, dependencies are `package.json` text, and the check is a pure function over the sources. A second `checkModule` run would double the compiler load and could only differ under the wall-clock budget, which yields a `budget` refusal, not a differing manifest. Recommend closing GRA-11 as satisfied by construction; the roadmap row now says so and names the trigger that reopens it (a manifest read by running the module).
- **A version's `package.json` carries `"type": "module"`**, set by the publish when the draft omitted it. Found by the Docker test: without it Node prints `MODULE_TYPELESS_PACKAGE_JSON` into every run's combined stream. The manifest reader already refused any other value.
- **Drafts carrying a lockfile, `.npmrc` or `node_modules` are refused, not stripped.** A model-written lockfile would make `npm ci` resolve from wherever it said; an `.npmrc` would redirect the registry. Same for `devDependencies` and the other sections npm installs from but the policy would not have seen.
- **Allowlisted packages never reach the registry.** The exact-version rule applies to them too (ADR 0013).
- **The store gained `read`** beyond the five verbs specified: the lockfile hash needs one file, and `readTree` on an installed version would pull `node_modules` as text.
- **A directory written and not recorded** (failed install, database down) stays; the next publish computes the same number and writes over it. Two publishes racing on one tool: the unique constraint refuses the second's row — `acquire` runs one job per tool (GRA-29).
- **`allowImportingTsExtensions` moves to the base tsconfig.** `@graft/check`'s core imports `./annotations.ts` for the worker's native resolution, and TypeScript refuses that in any program reaching the file — every consumer of a check type. Legal under `noEmit`, which every workspace sets.

## How verified

`pnpm run check`, `pnpm run lint`, `pnpm run check-types` (14/14), `TEST_DATABASE_URL=… pnpm run test --force` (`Cached: 0`): toolbox 23 (conformance, layout, mirror, the fake sandbox and the store as one tree), publish 61 (policy per rule, registry source against recorded responses, manifest, hashes, the service with the real check, and the Docker integration: `left-pad@1.3.0` vendored through the real install, run offline through `runner.mjs`, the registry unreachable from that sandbox), env 23, core 94, sandbox-docker with the conformance suite, server's integration suite against Postgres 18.

By hand, against a scratch database and `graft-sandbox:dev` on an internal network:

```
$ pnpm --filter @graft/server publish-fixture -- --dir ../../packages/publish/fixtures/hello --vendor demo --name hello --description "Greets a name" --email gra18@example.com --password '…'
{ "ok": true, "version": { "number": 1, "path": ".../tools/demo/hello/v1", "lockfileHash": null }, "annotations": { "readOnly": true, "destructive": false } }
$ GRAFT_SANDBOX_IMAGE=graft-sandbox:dev GRAFT_SANDBOX_NETWORK=graft-sandbox-gra18 GRAFT_PACKAGE_ALLOWLIST=left-pad pnpm --filter @graft/server publish-fixture -- --dir ../../packages/publish/fixtures/left-pad --vendor demo --name pad …
{ "ok": true, "version": { "number": 1, "path": ".../tools/demo/pad/v1", "lockfileHash": "10405aac…" }, "dependencies": ["left-pad"] }
$ ls .graft/toolboxes/<person>/tools/demo/pad/v1
index.ts  node_modules  package-lock.json  package.json
$ … --name pad-refused …        # without the allowlist: the live registry says left-pad carries no attestation
{ "ok": false, "refusals": [{ "rule": "package-policy", "file": "package.json", "line": 3, "column": 5, "message": "left-pad@1.3.0 fails the package policy (provenance): …", "policy": { "package": "left-pad", "version": "1.3.0", "rule": "provenance" } }] }
$ … --name hello … (again)
{ "ok": true, "version": { "number": 2 } }
 vendor | name  | read_only | current | versions
 demo   | hello | t         |       2 |        2
 demo   | pad   | f         |       1 |        1
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)


## Final report addendum (agent, 2026-09-09): exact interfaces. Merged as PR #8, main 4de6d99, head 2310058.

Name collision to know: core's `publishToolVersion(ctx, principal, toolId, versionInput, definitionPatch, deps)` is the ROW half; `@graft/publish`'s `publishToolVersion(deps, args)` is the WHOLE publish (imported in the service as `recordPublishedVersion`). Observation: the check counts a call into a vendored package as a write (GRA-3's conservative rule), so an SDK-using tool publishes `readOnly: false`.

### `@graft/toolbox`
```ts
type ToolboxFile = { path: string; content: string };
type ToolboxStore = {
  readTree(toolboxId, path): Promise<ToolboxFile[]>;      // recursive, relative to path, sorted; rejects "no such directory in the toolbox"
  writeTree(toolboxId, path, files): Promise<void>;        // creates dirs; overwrites same-named; root "" refused
  read(toolboxId, path): Promise<string>;                  // rejects "no such file in the toolbox"
  list(toolboxId, path): Promise<string[]>;                // names directly under; "" = root
  exists(toolboxId, path): Promise<boolean>;
  remove(toolboxId, path): Promise<void>;                  // DRAFTS ONLY (isDraftPath) else rejects "(ADR 0009)"; absent draft resolves
};
// bad toolbox id (assertSandboxName rule) or bad path (assertToolboxPath: relative, no "" "." ".." segments) rejects before touching anything
type ToolboxMirror = { mirrorVersion(toolboxId, versionPath): Promise<void> };  // never awaited by publish; failure → one onMirror "failed" event
createFilesystemToolboxStore({ root }): ToolboxStore & { root; toolboxRoot(id) }
createNoopToolboxMirror(): ToolboxMirror & { calls: { toolboxId; versionPath }[] }
toolboxStoreConformance(name, makeFixture)   // "@graft/toolbox/conformance"
// layout ("@graft/toolbox/layout"): TOOLBOX_MOUNT_PATH="/tools", PUBLISHED_DIR="tools", DRAFTS_DIR=".drafts",
// versionPath(vendor,name,n) → `tools/${vendor}/${name}/v${n}`, toolPath(vendor,name), draftPath(jobId) → `.drafts/${jobId}`,
// isDraftPath(path), sandboxPath(toolboxPath) → `/tools/${toolboxPath}`, toolboxIdOf(personId) → personId, assertToolboxPath(path,{allowRoot?})
```
On disk: `<GRAFT_TOOLBOX_ROOT>/<toolboxId>/tools/<vendor>/<name>/v<N>/{index.ts, package.json, package-lock.json, node_modules/}` and `<root>/<toolboxId>/.drafts/<jobId>/`. `tool_version.path` = `tools/<vendor>/<name>/v<N>`; inside a sandbox = `/tools/tools/<vendor>/<name>/v<N>` (`sandboxPath(version.path)`).

### `@graft/publish`
```ts
type PackageMetadata = { publishedAt: Date | null /* package's first publish */; weeklyDownloads: number | null; hasProvenance: boolean };
type PackageMetadataSource = { lookup(name, version): Promise<PackageMetadata | null> };  // null = no such pkg/version; rejects RegistryUnavailableError
createFakeMetadataSource(entries: Record<string, PackageMetadata | null | Error>)   // keyed "name@version" or "name"
createRegistryMetadataSource({ fetch?, registryUrl? = "https://registry.npmjs.org", downloadsUrl? = "https://api.npmjs.org", timeoutMs? = 10_000 })
type PackagePolicyConfig = { allowlist: readonly string[]; minAgeDays: number; minWeeklyDownloads: number };
DEFAULT_PACKAGE_ALLOWLIST = ["googleapis","@octokit/rest","@slack/web-api","@linear/sdk","@notionhq/client","airtable","stripe","@hubspot/api-client","@sendgrid/mail","twilio","@aws-sdk/*"]
DEFAULT_PACKAGE_POLICY = { allowlist: DEFAULT_PACKAGE_ALLOWLIST, minAgeDays: 90, minWeeklyDownloads: 1000 }
type PackagePolicyRule = "invalid-name" | "exact-version" | "unknown-package" | "provenance" | "age" | "downloads";
type PackageVerdict = { allowed: true; reason: "allowlist" | "attested" } | { allowed: false; rule: PackagePolicyRule; message: string };
evaluatePackage({ name, version, metadata }, config & { now: Date }): PackageVerdict
// order: invalid-name → exact-version → allowlist (allowed) → unknown-package → provenance → age → downloads

type PublishRule = "draft-missing" | "draft-contents" | "manifest-invalid" | "package-policy" | "registry-unavailable" | "install-failed";
type PublishDiagnostic = Omit<Diagnostic, "rule"> & { rule: DiagnosticRule | PublishRule; policy?: { package; version; rule: PackagePolicyRule } };
type PublishArgs = { personId; agentId?; jobId?; toolboxId; vendor; name; description; inputSchema: Record<string, unknown>; draftPath /* toolbox-relative dir or single .ts/.mjs/.js/.mts file */; defaultConnectionId? };
type PublishDeps = { db: DbOrTx; store: ToolboxStore; mirror: ToolboxMirror; sandbox: Pick<SandboxBackend, "install">; metadata: PackageMetadataSource; policy: PackagePolicyConfig; tool: ToolDeps; check: ModuleCheck; now: () => Date; onMirror: (event: MirrorEvent) => void };
createPublishDeps({ db, store, mirror, sandbox, metadata, policy, tool?, check?, now?, onMirror? }): PublishDeps
type MirrorEvent = { outcome: "mirrored" | "failed"; personId; agentId; toolboxId; versionPath; toolId; versionId; durationMs; cause? };
publishToolVersion(deps: PublishDeps, args: PublishArgs): Promise<PublishOutcome>
// throws ServiceError("BAD_REQUEST") for bad vendor/name/description/schema and Error for a bad draftPath, before reading the store
type PublishSuccess = { ok: true; tool: AuthoredToolRow; version: ToolVersionRow; advice: Diagnostic[]; annotations: ToolAnnotations; dependencies: string[] };
type PublishRefusal = { ok: false; refusals: PublishDiagnostic[]; advice: Diagnostic[]; annotations: ToolAnnotations };
```
Drafts carrying lockfiles/.npmrc/node_modules are REFUSED (`draft-contents`); dependency sections other than `dependencies` refused (`manifest-invalid`); `"type"` other than `"module"` refused; publish writes `"type": "module"` when omitted. Version row: `path`, `sourceHash` (sha256 over sorted files), `lockfileHash` (sha256 of package-lock.json or null), `checkOutput` = `{ entry, refusals, advice, annotations }`, `writesInvolved = !annotations.readOnly`, `publisherJobId`. Test helper `@graft/publish/testing` → `createInMemoryToolDeps()`, `fakeDb`.

### Additions elsewhere
`@graft/core`: `nextVersionNumber(ctx, principal, toolId, deps)`, `validateToolDefinition({ vendor, name, description, inputSchema })`. `@graft/sandbox-docker`: `DockerSandboxBackendOptions.toolboxHostRoot?: string` (bind `<root>/<toolboxId>`; sandbox-written files are uid 10001 → the server removes such drafts only when it runs as that user, GRA-33). `allowImportingTsExtensions: true` moved into `@graft/config/tsconfig.base.json`.

### Env (`@graft/env`)
`GRAFT_TOOLBOX_ROOT` (default `./.graft/toolboxes`), `GRAFT_PACKAGE_MIN_AGE_DAYS` (90), `GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS` (1000), `GRAFT_PACKAGE_ALLOWLIST` (comma list, `@scope/*` ok, bare `*` refused), `GRAFT_SANDBOX_IMAGE`/`GRAFT_SANDBOX_NETWORK` (optional all-or-nothing pair). Dev script: `pnpm --filter @graft/server publish-fixture -- --dir <dir> --vendor v --name n --description "…" (--person <id> | --email <e> [--password <pw>]) [--schema file.json]`; fixtures in `packages/publish/fixtures/{hello,left-pad}`.
