# executor.sh teardown: custom functions, and what Graft takes

Read against the clone at `/tmp/executor-sh-analysis/executor`, main at commit `2dc399e`
(2026-09-05), and the removed plugin extracted at commit `75f16edd` into
`/tmp/executor-sh-analysis/apps-plugin-pre-removal`. PR facts from `gh pr view N -R
UsefulSoftwareCo/executor`. Graft terms as defined in `CONTEXT.md`.

## What executor is

Executor (UsefulSoftwareCo/executor, MIT, about 3.6k stars) is an integration layer: configure MCP
servers, OpenAPI specs and GraphQL APIs once, with auth and per-tool policy, and expose that one
catalog to any MCP client (`README.md`). `vision.md` calls it "a catalog of every operation across
a company's software" with one verb, `execute(path, args)`, over addresses
`tools.<integration>.<org|user>.<connection>.<tool>`. Five forms (`README.md`, "Ways to run"):
Executor Cloud, the CLI, a desktop app, self-host on Docker, self-host on Cloudflare.

Model-written code never runs in a launched container; the only `docker` references in runtime
code are the stdio MCP transport and an e2e boot script. The Docker self-host wires
`makeQuickJsExecutor()` as its `CodeExecutorProvider` (`apps/host-selfhost/src/execution.ts`): a
WASM interpreter with a five-minute default timeout, a 64 MB memory cap, `fetch` stubbed to throw,
and no `process`, `require` or filesystem (`packages/kernel/runtime-quickjs/src/index.ts`,
`sealed-bundle.ts`). Cloud runs a Cloudflare dynamic worker with `globalOutbound: null`, so
`fetch()` throws there too (`packages/kernel/runtime-dynamic-worker/src/executor.ts`).

## The claim versus what ships

The GitHub description promises "custom js functions in secure environment". At `2dc399e` no such
mechanism exists. The engine landed as PR #1362 "Apps engine" (merged 2026-07-08, stacked on
#1361, which gave plugins `ctx.execute` and a schema projection hook) and was deleted twenty days
later by PR #1476 "Remove the custom apps plugin (it'll come back but better)" (merged 2026-07-28,
+33 / -12,738). Two earlier designs closed unmerged: #1332 (sync `tools/*.ts` from a GitHub repo,
closed 2026-07-08) and #1333 (an apps subsystem with an `apps_publish` MCP tool, closed
2026-07-06). `apps/docs` never mentions custom tools or `defineTool`.

Model-authored code today means the ephemeral `execute` tool (code mode, tool calls bridged to the
host) and `create-artifact`, persisted model-written JSX with integration roles bound to the
author's connections (`packages/hosts/mcp/src/tool-server.ts`, `artifact-bindings.ts`,
`plans/artifacts.md`). `vision.md` names an `author_tool` MCP tool; it appears nowhere else in the
tree.

## How the removed design worked

- **Authoring.** `defineTool({ description, integrations: { field: integration("slug") }, input,
  output, annotations: { readOnly, destructive, requiresApproval }, handler(input, ctx) })`
  (`authoring.ts`). `integration(slug).array()` asks the caller for several connections. Schemas
  are Standard Schema or raw JSON Schema.
- **Source and sync.** Human-authored `tools/<name>.ts` in a git repository or a local directory,
  synced manually over HTTP (`POST /apps/sources/:slug/sync`, `plugin/routes.ts`,
  `plugin/apps-plugin.ts`). No agent-facing publish tool existed; the plugin registered no tools of
  its own. The design was never agent-authored.
- **Pipeline.** `discover` (one tool per file; `workflows/`, `ui/`, `skills/` reported "not
  supported yet"), `bundle`, `collect`, `project` (`pipeline/publish.ts`). Collect executes the
  bundle twice in the sandbox and refuses with `nondeterministic` when the manifests differ
  (`executor/app-tool-executor.ts`, mirrored in the workerd and dynamic-worker executors). Limits
  256 files, 1 MiB per file, 4 MiB total; publish is compare-and-swap on the source ref
  (`AppPublishConflictError`).
- **Projection.** Tools mount at `tools.<app>.org.published.<name>`. Each integration role becomes
  a required input field whose schema is an enum of the caller's connection addresses
  (`plugin/apps-plugin.ts`, lines 676 to 687), so the choice of account is data in the call.
- **Invoke.** `resolveIntegrationBindings` maps role to connection, naming the candidates when it
  cannot (`plugin/bindings.ts`). The handler receives `AppIntegrationClient` proxies; every call
  goes `bridge.call` then `ctx.execute(address)` (`plugin/resolver.ts`), so policy, approval and
  credential resolution run host-side and code never sees a credential. Timeout 30 s; isolate key
  `${tenant}:${bundleKey}:${DRIVER_VERSION}` so byte-identical bundles from two tenants never share
  a warm isolate. Three backings: in-process ("not a security boundary", tests only), workerd
  subprocess, Cloudflare dynamic worker.

## The rework plan

`plans/kill-plugin-system.md` (Rhys, 2026-07-27 and 28). Diagnosis: "the plugin system is a
fiction", about 850 lines and twenty optional hooks, no fourth protocol plugin ever shipped. Phase
3, "custom = concept package": published source, manifest derived by executing the source,
content-hashed immutable versions, rollback as a pointer move, generators `fromOpenAPI` and
`fromMCP` with a re-verifiable `GeneratorClaim`, and publish-time evaluation routed through the
sandbox `collect` path "from day one". The bindings bridge, the three executors and the authoring
SDK are marked model-agnostic and kept.

Decision D49, the deep semantic delta: handlers get **credential fields as data**
(`ResolvedConnection.fields`, for example `access_token`) for direct HTTP, because that is what
lets generated code raw-`fetch`. Also decided: git and local directory become fetchers producing
`SourceFiles`; the content hash is the version identity; app rows carry a `space` and no owner.
`plans/artifacts.md` adds the rule that the artifact table carries the `owner: "org" | "user"`
tier column from day one so sharing later needs no migration.

## OAuth

`packages/core/sdk/src/core-tools.ts` exposes `oauth.clients.list`, `.create` (public PKCE
clients only, secret fixed to the empty string, approval-gated), `.createHandoff` (a URL opening
the web form pre-filled with every non-secret field; not approval-gated because it routes the
secret to the human), `.registerDynamic` (RFC 7591 dynamic client registration, approval-gated)
and `.remove`. `apps/cloud/src/engine/first-party-oauth-clients.ts` declares thirteen first-party
clients, each enabled only when its id and secret pair is present: Airtable, Atlassian, Box,
ClickUp, Figma, GitHub, GitLab, Google, HubSpot, Linear, Microsoft, Notion, Slack. `allowedScopes`
is fail-closed when set (`firstPartyOAuthClientAllowsScopes`, `oauth-client.ts`); ten set it,
while ClickUp, GitHub and Notion omit it and so allow every declared scope. Google carries
`isListed: makeGoogleOAuthListing(...)`, "offer the app only to the review rollout". Nothing under
`apps/host-selfhost` references `firstPartyOAuthClients`. ADR 0005's "each behind a fail-closed
scope allowlist" is true of ten, not thirteen.

## What Graft takes and what it declines

**Takes.**

- **The handoff URL for secrets.** `createHandoff` is the shape of Graft's handoff and console
  (ADR 0006); ADR 0005 adopts the same split, public PKCE clients registrable by the agent,
  confidential ones only through the console.
- **Integration roles bound at call time.** A tool declares the vendor, not the account; the
  connection arrives at invoke. Graft's authored tool is "bound to a connection's vendor rather
  than a connection row" (`CONTEXT.md`) and the scope supplies the connection (ADR 0007).
- **The determinism gate.** Collect twice, refuse if the manifests differ. No Graft ADR records
  this; it belongs in the check (`CONTEXT.md`) at the L0 publish gate (ADR 0012) and is a
  recommendation from this teardown, not a decision.
- **Annotations feeding policy defaults.** ADR 0008 takes executor's annotation-derived defaults,
  with one correction: Graft's checker sets `readOnlyHint` and `destructiveHint` from the methods
  the module uses, never from the model's own declaration.
- **The owner-tier column from day one.** ADR 0007 cites the rework plan for it.
- **Fail-open validation, narrowly.** Executor pins by test that a validator's own breakage never
  blocks the user's action (`sealed-bundle.ts`, `plans/artifacts.md`). Graft takes the distinction
  between "the check found a fault" and "the check could not run"; ADR 0010's security refusals
  fail closed, and no ADR records a fail-open rule.

**Declines.**

- **Credentials as data (D49).** ADR 0010 rejects it outright: model-written code can print the
  token, and egress isolation is the defence the Docker form can least guarantee.
- **The catalog and gateway model.** ADR 0001: Graft is the loop, not a catalog and not an MCP
  gateway in front of other servers.
- **A general plugin system.** ADR 0002 cites executor's own diagnosis and chooses two backings
  per seam.
- **An in-process sandbox without a filesystem.** ADR 0002 and ADR 0013: authored tools need a
  filesystem and a route to the proxy, so Graft's sandbox is a short-lived container or a Blaxel
  sandbox, at the cost of the Docker socket executor avoided.
