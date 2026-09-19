# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` is a symlink to this file.

## Before anything else

1. Read `CONTEXT.md`. Every term is used exactly as defined there, in code, comments, copy and
   tickets. When a word has an _Avoid_ list, the list is binding.
2. Read the ADRs under `docs/adr/` that touch the area you are about to work in. They are the
   decisions; this file only points at them.
3. Read `docs/roadmap.md` for what is in scope now and what is deliberately later.
4. Read the pull request body of any ticket you build on; `docs/reports/README.md` indexes them by
   ticket. The body is the build record — the contracts later tickets were told to match, what was
   verified by hand and what was not, the deviations and their reasons — and is where the thing a
   later ticket trips over is written down. An ADR records a decision; Linear holds the ticket.

## Working agreement

- **Every pull request has a Linear ticket** in the Graft project, and the PR references it.
- **`main` is protected.** Branch, push, open a PR. Merging needs one approving review, a green
  `Typecheck, Lint & Test` check, and a clean Greptile review; Greptile reviews every PR and edits
  its comment in place, so check the SHA it says it reviewed.
- **A comment states the local consequence and points at the ADR for the argument.** Do not
  restate an ADR in a comment; it will rot. A comment that asserts the state of code elsewhere is
  a claim with a date on it, so name the file or the ticket a reader can check in one step.
- **Consent never moves inside the loop.** Secrets are entered in the console, never through a
  tool argument or a chat. Approvals are the person's. If a change would let Graft's own model
  enter a credential or answer an approval, stop and read ADR 0004 and ADR 0006. The ask card a
  chat product renders (ADR 0006 as amended 2026-09-18) answers exactly two asks — the build
  approval and the keyless connection confirmation — only from an OAuth-connected agent's own
  ask, through a tool the host hides from the model; read that amendment before touching
  `packages/mcp/src/tools/answer-ask.ts` or widening what `answerable` admits.
- **The approval grain is ADR 0008 as amended on 2026-09-15 and 2026-09-18.** Reads never ask; any
  other tool, destructive included, asks once per agent and the answer holds; asking on every call
  is the person's opt-in per tool (`askEveryCall`), both ways. The connection confirmation may
  record `acquire`'s build approval for the asking agent (`approveBuild`, on by default): the person
  answers on the same page, and the grain does not move. Read the amendments before changing
  `packages/core/src/approval/approval.decision.ts` or the ask in `packages/mcp/src/approval.ts`.
- **The proxy is the only route to a vendor.** A sandbox with any other egress, or a module that
  holds a credential, violates ADR 0010 and ADR 0013 whatever the reason.
- **No vendor in the open repository** (ADR 0002 as amended 2026-09-19): no vendor's client
  library, configuration variable or id. Define the seam here, with the open form's backing or a
  no-op, and put the vendor's backing in graft-cloud's private package. Before adding a package or
  a `GRAFT_*` variable, ask whether it is a vendor's; if it is, it goes there. The Pipedream
  provider is the one exception left, and GRA-103 moves it.

## Lineage

The core is copied from Cando's authored-tools framework and Modern's forward proxy (ADR 0011).
When a piece here looks like a piece there, the copy is deliberate and the divergence is the
tenancy model (ADR 0007) and the approval grain (ADR 0008). Do not "sync" from Cando; Cando will
adopt Graft, not the reverse.

## Commands

```bash
pnpm install           # Node 24 and pnpm 10; `packageManager` pins the exact pnpm
pnpm run check         # biome format + lint, writes fixes
pnpm run lint          # biome ci: what CI runs, no writes
pnpm run check-colours # the console: a hard-coded colour, a colour literal in @theme, a mode-orphaned token (ADR 0017)
pnpm run check-tokens  # the console: every design-token utility compiles into apps/web/dist — build first
pnpm run check-types   # turbo: tsc per package
pnpm run test          # turbo: vitest per package
pnpm run build         # turbo: only packages that declare a build script
pnpm run dev           # turbo: persistent, only packages that declare a dev script
docker compose up -d   # the self-hosted form, whole: Postgres, Graft (server, proxy, MCP, console), the sandbox image
pnpm run db:start      # postgres:18 alone, via the same compose file, port 5432 (GRAFT_POSTGRES_PORT overrides)
pnpm run db:push       # apply packages/db/src/schema/*.ts directly — the dev loop
pnpm run db:generate   # write a migration under packages/db/drizzle from the schema
pnpm run db:migrate    # apply the committed migrations
pnpm run db:check-chain # journal ↔ files ↔ prevId chain, no database — the third of three guards
pnpm run db:studio     # Drizzle Studio
```

### The compose file is the development environment

`docker-compose.yml` at the root is the self-hosted form (ADR 0002) and, from GRA-33 on, the way this
repository is run whole: `docker compose up -d` brings up Postgres, builds the sandbox image, and runs
the server image — server, proxy, MCP endpoint and console in one container — with migrations applied
and an admin opened on first start. README, "Self-hosting", is the walkthrough; the compose file's
comments are the reference for each name. Two ways to use it while developing:

- **Postgres alone** (`pnpm run db:start`) and the server from source on the host (`pnpm run dev`) —
  the inner loop, where `tsx watch` and Vite reload. `apps/server/.env` names the database for it.
- **Everything in containers** (`docker compose up -d --build`) — to see the image a self-hoster
  gets, or to run the loop end to end with Docker sandboxes and no host setup. `.env` at the root
  (from `.env.example`) holds its secrets, model key and admin.

Use a distinct project name (`docker compose -p <name> …`) to run a second copy beside a colleague's:
the sandbox network and the toolbox volume are named after the project, so two never share one.

### The database

Postgres in both forms (GRA-1), Drizzle in `packages/db`. `drizzle-kit` is that package's dependency
and not a root one — every root `db:*` script filters to `@graft/db` for that reason, and `pnpm exec
drizzle-kit` at the root fails with "command not found". `drizzle.config.ts` reads `GRAFT_DATABASE_URL`
from `apps/server/.env`, the one file that names the development database for the app and the CLI
alike. `db:push` is for development; `db:generate` + `db:migrate` when a change has to be versioned.

Three guards, each catching what the other two cannot: `drizzle-kit check` finds a *fork* (two
snapshots sharing a `prevId`), `drizzle-kit generate` producing nothing means the schema matches the
*tip*, and `db:check-chain` (`packages/db/src/migration-chain.ts`) finds a *hole* — a journal entry
whose `.sql` is absent, a snapshot missing from the middle, a `prevId` pointing at nothing. CI runs all
three as their own steps.

The four Better Auth tables in `packages/db/src/schema/auth.ts` are generated by
`pnpm --filter @graft/auth generate-schema`, not hand-written; only the file's header comment is
ours, so put it back after a run. The CLI is the `auth` package since Better Auth 1.7
(`@better-auth/cli` stopped at 1.4.21), published in lockstep with the library, and the script runs
the version matching the installed `better-auth`, so the generator and the runtime cannot drift.
Regenerate rather than edit when the auth configuration or that version changes, then
`db:generate`: Better Auth 1.7.3 validates the schema at init and refuses a required column it
never writes (GRA-86, migration 0008).

**Two suites need Postgres**: `apps/server/src/database.integration.test.ts`, which migrates a fresh
throwaway database per run, and `apps/server/src/mcp-oauth.integration.test.ts`, which drives the MCP
SDK's client with an `OAuthClientProvider` through the whole OAuth flow over another (ADR 0018). Each
skips without `TEST_DATABASE_URL` and refuses to skip under `CI`, where the workflow runs a
`postgres:18` service. Locally, `pnpm run db:start` and
`TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/graft pnpm --filter @graft/server test`.
Every other suite runs with fakes and no database — `packages/core/src/agent/agent.service.test.ts`
is the reference shape — and `packages/db`'s suites pin the *rendered* SQL, which is where the rule
that every agent-scoped read takes the scope in the statement (ADR 0007) is asserted. The scope
itself is one such statement since ADR 0007's amendment of 2026-09-19 (GRA-105):
`listScopeConnectionIds` in `packages/db/src/repo/agent.ts` resolves an agent's `scope_mode` — `all`,
every connection of the person's, or `listed`, the rows in `agent_connection` — under the person and
both ids on each branch, and `getAgentScope` is that read; every mint of a capability token goes
through it, so the token names ids under either mode.

### Running the server locally

```bash
pnpm run db:start
pnpm --filter @graft/server keys >> apps/server/.env    # key pair, keyring, auth and handoff secrets
cat >> apps/server/.env <<'ENV'
GRAFT_DATABASE_URL=postgresql://postgres:password@localhost:5432/graft
GRAFT_AUTH_URL=http://localhost:3000
GRAFT_CORS_ORIGIN=http://localhost:3001
GRAFT_CONSOLE_URL=http://localhost:3001
ENV
pnpm --filter @graft/server dev
```

**The server migrates on start** (`apps/server/src/boot.ts`, GRA-33): before it listens it checks the
committed chain for holes — a hole refuses the start with the problems listed — and applies whatever
the database has not seen, so `db:migrate` is no longer a step. The exception is the `db:push` loop:
a pushed database has no migration ledger and the migrator would refuse to create tables that exist,
so set `GRAFT_MIGRATE_ON_START=false` while the schema is moving. Then, if `GRAFT_ADMIN_EMAIL` and
`GRAFT_ADMIN_PASSWORD` are set (all-or-nothing) and the database holds no person, the boot opens that
account through Better Auth's own sign-up and prints one line saying so; a database with anyone in it
is never touched, and the line says that instead. Unset, nothing happens — a laptop registers at
`/signup` and verifies the address from the link the console transport prints (ADR 0020, ADR 0021).

`GRAFT_DATABASE_URL`, `GRAFT_AUTH_SECRET` (32+), `GRAFT_AUTH_URL`, `GRAFT_CONSOLE_URL` (where the
console answers — the base of every handoff URL) and `GRAFT_HANDOFF_SECRET` (32+, signs those URLs)
are required, and so is `GRAFT_KEYRING_SECRET` (32+) under the default `GRAFT_BACKINGS=open`;
`GRAFT_CORS_ORIGIN` is an optional comma-separated list of origins; the capability token key pair is
all-or-nothing; `GRAFT_DEV_SEED` layers a JSON file of connections over the database for a proxy
smoke test and is refused in production. A refusal prints one line per problem with the variable
named and exits 1 (`packages/env/src/server.ts`). Under `NODE_ENV=production` on the open backings the
model group ADR 0014 requires — `GRAFT_MODEL_BACKEND=provider` with `GRAFT_MODEL_PROVIDER` and
`GRAFT_MODEL_API_KEY`; `GRAFT_MODEL_AUTHORING` and `GRAFT_MODEL_TRIAGE` are optional beside them
and default per provider — is required too; the fields and that rule are GRA-31's (the section
*Running `acquire` locally* below). `GRAFT_APPROVAL_WAIT_SECONDS` (default 25) is how long a
tool call waits for a person to answer a handoff before returning
`awaiting_approval` — or `awaiting_connection` / `awaiting_credential` for the two connection
handoffs (GRA-28), which share the wait and the TTL — and `GRAFT_PENDING_ACTION_TTL_HOURS` (default
24) how long that action stays answerable (ADR 0006, ADR 0008). `GRAFT_CARD_HOSTS` (default
`claude.ai,chatgpt.com`) names the chat products whose OAuth clients may answer the ask card, by the
host of their registered redirect URIs (GRA-84; the paragraph on the card below). `packages/env/src/schema.ts` is the
rules as code.

**An OAuth consent (ADR 0005) adds no variable, two server routes and one console route.**
`GET /api/oauth/redirect-uri` is `GRAFT_AUTH_URL` plus `/api/oauth/callback`, computed by one function
(`@graft/core`'s `oauthRedirectUri`) that both the form and the callback's mount read, so the URI
shown is the URI served in both deployment forms — a person registering a Google client pastes it as
the redirect URI. `GET /api/oauth/callback` takes the vendor's `code` and `state` **with no session**:
the state is an HMAC under `GRAFT_HANDOFF_SECRET` over the connection, the person and the ask, so the
browser that arrives from the vendor carries its own authority. It renders nothing (GRA-48): once the
tokens are stored — or the state, the vendor or the exchange refused — it redirects to the console's
`/oauth/callback` under `GRAFT_CONSOLE_URL` with `status`, `connectionId` and `message` in the query
and never the code, the state or a token; `apps/web/src/routes/oauth.callback.tsx` draws the outcome
in Cando's empty-state shape, tells the waiting console over `postMessage` at its own origin and the
`graft:oauth` `BroadcastChannel`, and closes itself after 1.5 s on success. The writer and the reader
of that query are one browser-safe file, `@graft/core`'s `oauth.rules.ts`, and the popup contract —
the console's `awaitConsent` reading the message from its own origin — is exercised on both sides in
`apps/web/src/lib/oauth-consent.test.ts`. `apps/server/src/oauth.ts` is the **second place
this server decrypts a credential** — the client secret, for the code exchange — beside the proxy
binding in `app.ts`; `@graft/core` still takes the vault's encrypt half only. The token refresh runs
in the proxy's scheme plugin, single-flight per connection, and stores the rotated record through
`ProxyDeps.storeCredential` (`apps/server/src/connections.ts` binds it); a refused refresh passes the
vendor's 401 through and marks the connection for re-consent. An `oauth_authorization_code`
connection keeps its client id, endpoints and scopes in `scheme_config` and the client secret and the
issued tokens in one `credential_ciphertext`; the five `oauth_*` columns from GRA-6 other than
`oauth_refresh_state` are unwritten and await a drop migration.

`GRAFT_BACKINGS` picks the backing behind each seam (ADR 0002; `apps/server/src/backings.ts`).
`open`, the default, is what this repository holds — the sandbox `GRAFT_SANDBOX_BACKEND` names, the
local keyring, a mirror that copies nothing — and is also the self-hosted form in production.
`cloud` loads the hosted form's backings from a private package that is not in this repository: it
is placed at `packages/cloud-backings/`, which is gitignored, where the workspace glob picks it up
and `apps/server`'s `optionalDependencies` entry links it into the server's `node_modules`; absent,
the install still succeeds and the server refuses to boot with a sentence saying so. The selector
imports it by a name held in a variable, so the type program never resolves it — which is what keeps
the package absent rather than optional.

**A connection comes from a provider, and the providers ride the same selector** (ADR 0019,
GRA-57). `Backings.providers` is an ordered list — under `open` the keyring alone, under `cloud`
whatever the private package answers with the keyring appended last, and the boot line names them
(`providers keyring`). A provider (`packages/core/src/connection/provider.ts`) decides how a vendor
gets connected (`form` over the proxy's schemes, `link`, or `none`), how a call resolves (`inject`
the row's credential, or `relay` through an upstream that holds it), and what to release on revoke;
`request_connection` routes a proposal to the first provider that covers it, and the proxy's
connection read (`apps/server/src/connections.ts`) asks the row's provider how the call resolves.
The relay engine is `packages/proxy/src/relay.ts`: a relay plugin rewrites the resolved vendor
request into the upstream's under `RelayHeaderRules` as data, and `relay.test.ts` drives it through
an in-process upstream. `RELAYS` holds the `gateway` plugin (`gateway-relay.ts`, GRA-58) and
Pipedream's (`pipedream-relay.ts`, GRA-59), and `RELAY_SCHEMES` names both. A row of a relay
provider records its relay scheme in the `scheme` column, and the enum pin in `packages/core` covers
both lists — so `connectionScheme` now carries `gateway` and `pipedream_connect_proxy`, which no
form, proposal or credential entry accepts (`connection.rules.ts` refuses a relay scheme with a
sentence). With the keyring alone nothing observable changed. With both providers configured the
gateway is routed to first: an operator's explicit host list wins over Pipedream's app table
(`environmentProviders` in `apps/server/src/backings.ts`).

**The gateway provider is the environment's** (ADR 0019 as amended 2026-09-17, GRA-58): the
`GRAFT_GATEWAY_*` group — covered hosts, upstream URL, the identity header's name and value, an
optional caller-header prefix — all-or-nothing and off by default, read by `gatewayProviderFrom` in
`apps/server/src/backings.ts`, which puts the provider first in either form's order. A proposal every
host of which it covers connects with **no person step**: `request_connection` makes the row
(`registerProviderConnection`, scheme `gateway`, no credential) and grows the asking agent's scope in
one transaction (a no-op for an agent on `all`, GRA-105); a row the person revoked or has not given
this agent is refused with the console step that would grant it, and a narrower in-scope gateway row is widened to a later proposal's
hosts within the coverage. The relay carries the vendor URL in the path, `<upstream>/<host>/<path>`,
and the provider brings the relay leg its own fetch with the gateway's hostname exempt from the
resolver's private-address rule (`createUpstreamFetch({ unguardedHosts })`, on `ProxyRelay.
upstreamFetch`) — the proxy's shared fetch keeps the full guard, so a vendor host spelling the
gateway's name is still judged on its address. A revoked gateway row comes back through the console's
Reconnect (`POST /api/connections/:id/reconnect`), the one row kind with nothing to re-enter. A fake
gateway on a loopback port stands in for a company's in `packages/proxy/src/gateway-relay.test.ts`
and `apps/server/src/app.test.ts`; on a laptop, `GRAFT_GATEWAY_UPSTREAM_URL` may be plain `http`
(refused in production).

**The Pipedream provider is open code switched on by configuration** (ADR 0019, its 2026-09-17
bullet; GRA-59). With the all-or-nothing group `GRAFT_PIPEDREAM_PROJECT_ID` (`proj_…`),
`GRAFT_PIPEDREAM_ENVIRONMENT` (`development` or `production`), `GRAFT_PIPEDREAM_CLIENT_ID` and
`GRAFT_PIPEDREAM_CLIENT_SECRET` set, `apps/server/src/backings.ts` (`environmentProviders`) puts
`pipedream` on the list ahead of the keyring in either form, after the gateway when that is
configured too, and the boot line reads `providers pipedream, keyring`; absent — the default —
nothing changes, and a partial group or a client secret still holding `PLACEHOLDER` refuses the
boot. Three homes, one per boundary: `packages/pipedream` is
the Connect client (`createPipedreamClient`: client-credentials access token with a minute of skew
and single-flight refresh, `createConnectToken`, `listAccounts`, `relayFields`, `deleteAccount`; it
never sets `include_credentials`), with an in-memory fake at `@graft/pipedream/fake` and Pipedream
on a loopback port at `@graft/pipedream/testing/fake-pipedream`; `packages/proxy/src/pipedream-relay.ts`
is the relay plugin (the vendor URL base64url'd into `/v1/connect/<project>/proxy/`,
`external_user_id` and `account_id` in the query, `Authorization: Bearer <Graft's Connect token>` and
`x-pd-environment`, every caller header under `x-pd-proxy-` with `content-type`/`accept` through and
Pipedream's restricted list plus `user-agent` dropped); `packages/core/src/connection/pipedream-provider.ts`
is the provider, and **`PIPEDREAM_APPS` there is the vendor table** — `gmail` at
`gmail.googleapis.com` and `www.googleapis.com` → Pipedream app `gmail` — where a vendor is added as
one row with Pipedream's own app slug (their catalogue is the source, ADR 0001); `covers` demands
every proposed host be in the entry's set, because the relay injects the account's token into
whatever vendor URL it is handed. The person is `graft-person-<personId>` at Pipedream
(`externalUserIdFor`). **The link**: `request_connection` records `providerConnect: "link"` and
`providerTarget` (the app slug) on the ask's payload and names the provider in the awaiting answer;
the console's card (`apps/web/src/components/pending/provider-link-ask-card.tsx`) posts
`POST /api/pending-actions/:id/link`, which mints Pipedream's Connect Link with both redirect URIs
pointing at `GET /api/providers/link/callback?state=…&outcome=success|error` — the state signed
under `GRAFT_HANDOFF_SECRET` for fifteen minutes (`packages/core/src/connection/link-state.ts`), the
connect token held to the same window — and opens it in a popup; the return
(`apps/server/src/provider-link.ts`, no session) never trusts the redirect's word but asks Pipedream
which account the person now holds under the app, minus the ids the person's other rows already
name, then in one transaction makes the row (`connectThroughProvider`: `provider_ref` = the account
id, `scheme` = `pipedream_connect_proxy`, `credential_ciphertext` null for life; a released row of
the same provider and vendor is reconnected in place whatever primary host and hosts the proposal
names within the coverage — its id, primary host and name kept, its hosts widened to the union,
the most recently revoked when several qualify, GRA-122), adds it to the requesting agent's scope
(a no-op for an agent on `all`, GRA-105), answers the ask, and redirects to the console's
`/link/callback` (`link.rules.ts` writes and reads the query). A revoke calls Pipedream's `DELETE …/accounts/{id}`; the revoke keeps `provider_ref` until
that succeeds, and a failure is stamped on `provider_release_failed_at` (migration 0007), which the
connection card shows with **Retry release** (`POST /api/connections/:id/release`).
`apps/server/src/scripts/pipedream-proof.ts` boots the whole server against the fake Pipedream for
a laptop proof; `apps/server/src/provider-link.test.ts` is the same flow as a suite.

**In the image the package arrives built** (GRA-38). The bundled server runs where there is Node and
`node_modules` and nothing else — no TypeScript, no workspace — so a linked package ships a `build`
of its own: `tsdown`, the `@graft/*` seam packages it imports inlined as the server's bundle inlines
them, its third-party imports left external; and its `exports` name `dist/index.mjs` under `default`
for the runtime and `src/index.ts` under `types` for the type program. `apps/server/Dockerfile` runs
that build when `packages/cloud-backings/` is present in the build context and copies `dist/` and
`package.json` to `/app/node_modules/@graft/cloud-backings`, a real directory beside the dependencies
the package imports; absent, the same lines do nothing, and the Dockerfile's comments say why each is
shaped as it is. One consequence on a laptop: `tsx` resolves the bare name through `default` exactly
as Node does, so a server run from source under `GRAFT_BACKINGS=cloud` needs
`pnpm --filter @graft/cloud-backings build` first — unbuilt, the import fails as module-not-found and
the selector's sentence says the package is not installed.

The MCP endpoint is `POST /mcp` with `Authorization: Bearer <agent token>` — `POST /api/agents` mints
the token, shown once. **A chat product connects over MCP OAuth instead of a pasted token** (ADR 0018,
GRA-53): `/mcp`'s 401 carries `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`;
`/.well-known/oauth-protected-resource` (both forms RFC 9728 admits) and
`/.well-known/oauth-authorization-server` answer at the origin's root from `apps/server/src/mcp-oauth.ts`,
mounted above the console's SPA fallback, which excludes the prefix; registration, authorization, token
and revocation are `/mcp/oauth/{register,authorize,token,revoke}`, CORS-open and outside `/api`. The
authorization endpoint judges the request and sends the browser to the console's `/consent` route with
the request as its query — a client or a redirect URI in doubt lands there as a refusal rather than
being redirected anywhere — and the console's `GET`/`POST /api/mcp-oauth/{request,consent}` describe
and decide it with the person's session. The decision mints the agent (`createAgentForClient`: no
static token, `connected_via_client_id`/`_name` recorded, on every connection of the person's
unless the consent's `scopeMode: "listed"` limits it to `connectionIds` — ADR 0007 as amended
2026-09-19) or names an existing one and binds an authorization code to it. Tokens are opaque and hashed in `mcp_token` (`@graft/db/repo/mcp-oauth`);
`requireAgent` dispatches on the prefix — `grft_` static, `grfta_` access token — and both resolve to
one agent, so nothing past the door knows which arrived. Access tokens live an hour; refresh tokens
rotate — one successor per predecessor, the claim and the pair one transaction — and live with the
agent; a rotated token presented again within thirty seconds is answered the same pair, opened from
a seal on the retired row that only the retired token can open (`mcp-oauth.replay.ts`), and past
thirty seconds it is a replay that revokes the grant; revoking the agent revokes every token in the
same transaction. No variable is added: the issuer is `GRAFT_AUTH_URL`'s origin and the
consent page is under `GRAFT_CONSOLE_URL`. The rules and the service are `packages/core/src/mcp-oauth/`;
the two suites are `packages/core/src/mcp-oauth/mcp-oauth.service.test.ts` over fakes and
`apps/server/src/mcp-oauth.integration.test.ts` over Postgres with the SDK's own client. Under `open`,
authored code runs on the backing `GRAFT_SANDBOX_BACKEND` names:
`docker` by default, which needs the `GRAFT_SANDBOX_IMAGE`/`GRAFT_SANDBOX_NETWORK` pair below and,
unset, leaves the server up with every run refusing for want of a sandbox; or `fake`, a temporary
directory on the server's own disk for a laptop without a daemon — the toolbox then lives in that
directory too, for as long as the process does — which is not a sandbox, and `@graft/env` refuses it
in production and beside `cloud`.

**The `initialize` result carries the playbook, and the descriptions carry none of it** (GRA-54,
GRA-111). `SERVER_INSTRUCTIONS` in `packages/mcp/src/session.ts` is what a client that loads no skill
— Claude.ai, ChatGPT, a bare MCP client — shows its model, and the one place on the wire a rule of
conduct lives: the order of operations, the handoff and secrets rules, the keyless and rotation
rules, the build approval on the connection page, `run_tool` for a client that snapshots its list,
the approval grain, and whose tool `answer_ask` is. Every tool description (`tools/meta.ts`,
`tools/authoring.ts`, `tools/execute.ts`, `tools/answer-ask.ts`) is a capability statement in the
third person — what the tool does, its arguments, its answer shapes, the `awaiting_*` shapes and
their `url` included — opening with when it is used, stated as a fact and not as an instruction:
ChatGPT's classifier badged GRA-54's rule-bearing descriptions "Suspicious Instruction" on every
call, and both hosts' published guidance puts behaviour in `instructions` (the research comment on
GRA-111 has the sources). `INSTRUCTIONS_BUDGET` is 2,048, Claude Code's documented per-server cap
on both fields (its CHANGELOG, 2.1.84), and the order of operations sits in the first 512 characters,
OpenAI's front-loading rule. `packages/mcp/src/session.test.ts` pins the shared sentences to
`skills/hermes-graft/SKILL.md`, each description to its opening sentence, every fixed tool's whole
definition against a denylist of conduct markers (`never`, `do not`, `always`, `you`), and every
description to the same 2,048. A rule belongs in the instructions and the skill; a fact about what a
tool answers belongs in its description; re-run the live check the ticket records if the order of
operations moves.

**The ask card is an MCP App a chat product renders in place of the handoff link** (GRA-84; ADR 0006
as amended 2026-09-18). `packages/ask-card` (`@graft/ask-card`) is one HTML page — plain TypeScript
over `@modelcontextprotocol/ext-apps`'s `app-with-deps`, no React — that `vite build` with
`vite-plugin-singlefile` inlines whole into `dist/ask.html`; hosts block external scripts and styles,
so nothing may be linked. Its stylesheet carries a copy of the console's `cando:tokens` block and
`src/bundle.test.ts` fails on a colour literal outside the `:root`/`.dark` rules (ADR 0017 over one
file). The MCP server (`packages/mcp/src/ask-card.ts`, `session.ts`) declares `resources`, lists the
one resource `ui://graft/ask` (`text/html;profile=mcp-app`, an empty `_meta.ui.csp` said outright:
the card fetches nothing) and serves the page from `@graft/ask-card`'s `ASK_CARD_HTML_PATH`, which resolves to
`packages/ask-card/dist/ask.html` in a checkout and to `dist/ask.html` beside the server's bundle,
where `apps/server/tsdown.config.ts` copies it and the Dockerfile's `build` stage builds it first.
Every tool that can ask carries `_meta.ui.resourceUri` unconditionally (Claude.ai declares no
extension): `acquire`, `request_connection`, `request_credential`, and — since a host renders a card
only for a tool whose definition names the resource (GRA-116's live check, 2026-09-20) — `run_tool`,
every `execute__<id>` and every authored tool in the list, whose first write answers the tool ask;
ChatGPT's alias `openai/outputTemplate` rides beside it, and the
resource carries the `openai/widget*` aliases of its `ui` keys (GRA-112); their awaiting results
carry the card's data under `structuredContent.card` beside GRA-55's unchanged `url`, `message` and
`reason` (`result.ts`'s `withCard`). **For a client the server knows renders the card, the awaiting
`message` takes its card form and `cardShown: true` rides beside `url`** (GRA-120; ADR 0006 as
amended 2026-09-20): `packages/mcp/src/card-client.ts`'s `clientRendersCards` is the card gate's
client half — an OAuth agent whose session declared the MCP Apps extension or whose client is
registered on a `GRAFT_CARD_HOSTS` host — held once per session, and its `toolAskResult` is where
every awaiting result goes onto the wire (`tools/meta.ts`, `tools/execute.ts`, `tools.ts`); each
ask flow writes both forms through `handoff-message.ts`, so the console form a static-token agent
or an unvouched client reads is byte for byte what it was, and `url` never changes.
`SERVER_INSTRUCTIONS` carries the one clause on what `cardShown` means; the Hermes skill does not,
since a Hermes agent never receives it, and `session.test.ts` records that. **An awaiting result
is not an MCP error**: every `awaiting_*`
answer returns through `result.ts`'s `toolAwaiting` with `isError: false` and the same JSON, because
a host renders no view for an error result (ext-apps issue 694) — refusals and failures stay
`isError: true`. The card answers by calling `answer_ask` (`tools/answer-ask.ts`), declared
`_meta.ui.visibility: ["app"]` so the host hides it from the model; the tool refuses a static-token
agent, an OAuth client whose hiding is not established (neither every registered redirect URI on a
`GRAFT_CARD_HOSTS` host nor the MCP Apps extension declared in `initialize`), another agent's ask,
a closed or expired ask, and every ask but the build approval, the tool's first-use approval
(GRA-116), the keyless connection confirmation, the scope ask and a link provider's decline, and
records the rest through `ask-answer.ts` — the same functions the console's
`POST /pending-actions/:id/answer` and `/connection` call, with `via: "card"` on the answer. The
gate is `tools/card-gate.ts`, shared with the two other app-only tools. `packages/mcp/src/answer-ask.test.ts`
is the suite; `pnpm --filter @graft/ask-card build` before `pnpm --filter @graft/mcp test` on a
fresh checkout, or let `pnpm run test` order it.

**Every ask settles in the card; the console is a popup for the secret alone** (GRA-116, GRA-117,
GRA-118; ADR 0006 as amended 2026-09-19). Three more tools and one query. `start_link
{ pendingActionId, approveBuild }` → `{ url, expiresAt, provider }` (`tools/start-link.ts`, app-only,
the card gate) mints a link provider's Connect Link for the agent's own open connection ask through
`packages/mcp/src/provider-link.ts`'s `mintProviderLink` — the function `POST /api/pending-actions/:id/link`
now calls too, so the two doors issue one link — with the build choice signed into the state and
`from=card` on the return URIs, which `apps/server/src/provider-link.ts`'s return route copies onto
its console redirect; `McpDeps.authUrl` is `GRAFT_AUTH_URL` for it. `ask_status { pendingActionId }`
→ `{ state, sentence }` (`tools/ask-status.ts`, app-only, read-only, the gate less the open check)
reads where the ask stands off the row — `open`, `answered`, `declined`, `expired` — with the
console's settled sentence for the kind. The card (`packages/ask-card/src/render.ts`) opens every
page it sends the person to with `from=card` (`withFromCard`; `ASK_STATUS_POLL_MS` is 3 s) and polls
`ask_status` until the ask is settled or the render is abandoned: *Connect through <provider>* on a
link ask, *Enter the secret in Graft* on a scheme with a credential or a credential re-entry, *Open
in the console* under a `card_not_available` refusal or where the host refused `ui/open-link`. The
console reads the flag through `@graft/core`'s browser-safe `connection/card.rules.ts`
(`openedFromCard`, `askAnsweredMessage`, `FROM_CARD_CLOSE_MS`): `/pending/:id?from=card` posts
`graft:ask` to its opener and closes itself 1.5 s after a successful submit, `/link/callback?from=card`
closes on a success and stays on a failure (the ask is still open, and the card is where the person
tries again), and neither behaves differently without it. `@graft/ask-card/shape` spells
`from=card` a second time, import-free, and `ask-card.test.ts` pins the two spellings together.

**A connection the person holds but this agent was not given is the `scope` ask** (GRA-104; ADR
0006 as amended 2026-09-19). `request_connection`'s match against the person's rows
(`existingConnectionFor` in `packages/mcp/src/connection-request.ts`, GRA-76) answers `connected`
for a usable row in scope and `connection_exists` for a revoked row or one whose credential is
missing; a live, usable row made for another agent is a pending action of kind `scope` — payload
`connectionId`, `vendor`, `displayName`, `provider`, `primaryHost`, `hosts`, `scheme`, `docsUrl`;
the `connection_id` column set, so a revoke closes it — and the call waits and polls as the
connection ask does, answering `awaiting_scope` with `url`, `message`, `pendingActionId`,
`expiresAt`, `connectionId` and `provider`. One open ask per agent and connection. The console's
card is `apps/web/src/components/pending/scope-ask-card.tsx` — Allow, Decline and GRA-75's build
choice, pre-ticked — and posts the generic `POST /api/pending-actions/:id/answer` with
`{ allow, approveBuild? }` (`AnswerBody`, exported from `apps/server/src/api.ts` for the console);
`recordApprovalAnswer` in `ask-answer.ts` grows the scope (`addConnectionToAgentScope`) and grants
the build approval in the answer's transaction, and leaves the answer for the agent's next call,
which answers `connected` naming the execute tool, or `scope_declined`. The ask card renders
`card.kind: "scope"` as answerable, and `answer_ask` admits `{ allow, approveBuild? }` for it under
the same gate. `SERVER_INSTRUCTIONS` names `scope` in its handoff list, and `session.test.ts`
pins the word across the description and the Hermes skill.

**A person's connections reach every agent of theirs by default; scope is a narrowing the person
opts into** (GRA-105; ADR 0007 as amended 2026-09-19). `agent.scope_mode` is `all` or `listed`
(`agentScopeMode` in `packages/db/src/schema/agent.ts`; migration 0009 added the column as `listed`
for every existing row and moved the default to `all`). `AgentOutput.scopeMode` is on the wire;
`GET /api/agents/:id` answers `connectionIds` as the scope resolves under the mode; `POST /api/agents`
and the consent's `agent: { kind: "new" }` take `scopeMode` (default `all`) and refuse
`connectionIds` beside `all`; `PUT /api/agents/:id/scope` takes `{ mode: "all" }` or
`{ mode: "listed", connectionIds? }` (`ScopeBody`, exported for the console), a `listed` write with
no list materialising the scope as it stood. In `@graft/core`, `addConnectionToAgentScope` is a
no-op for an agent on `all`, which is what makes every grant-on-connect path right without reading
the mode, and `listAgentIdsForConnection` — the agents a revoke announces to — takes every agent on
`all`. An agent on `all` never reaches the `scope` ask above: `existingConnectionFor` finds every
usable row in scope and answers `connected`. The console draws the mode as a `Select` — `All
connections` first, `Limit to these` revealing the picker — through `components/agent/scope-mode-field.tsx`
in the create dialog and the consent card, and in the agent page's Scope section
(`scope-editor.tsx`); the labels and the write's body are `src/lib/scope-mode.ts`, tested.

**A tool follows its vendor's reconnected connection** (GRA-122; ADR 0007 as amended 2026-09-20).
`authored_tool.default_connection_id` is the row the tool was authored against, and a run resolves
the connection **per agent** (`packages/mcp/src/run.ts`): the default when this agent holds it
live; otherwise — revoked, or a live row another agent of the person's holds and this one was never
given — the **one** live, usable connection of the tool's vendor in this agent's scope. The row is
rebound (`updateToolDefinition`, one patch) only when its default is revoked, dead for every agent;
a live default outside the scope is another agent's and stays. With no such connection the
`connection_revoked` or `connection_not_in_scope` refusal stands as before, and with several it
names them under `alternatives` and says the step is the person's (`revoke.ts`'s
`revokedConnectionRefusal`, `run.ts`'s `notInScopeRefusal`). A caller that names the connection
(`AuthoredRunArgs.connectionId`) is never followed: `acquire`'s dry run passes the job's connection,
so a version published onto an existing tool row is proved against the connection the job authored
it for; a publish onto an existing tool under `activate: false` rebinds the row to
`defaultConnectionId` in the publish's transaction only when the row's default is missing or
revoked — a live default waits for the pass, so a failed job leaves the tool where it was
(`packages/publish`, step 8). The job's "did not run" progress line and `tried[].summary` carry a
refusal's `reason: message` rather than the word `refused`. `packages/mcp/src/server.test.ts` (the
GRA-122 describe), `acquire.test.ts` and `publish.service.test.ts` are the suites.

### The self-hosted image

`apps/server/Dockerfile`, built from the repository root, is the one image (GRA-33). Its stages:
`manifests` collects every `package.json` at its path so the `deps` install layer is a cache hit on
any commit that leaves the lockfile alone; `build` runs the console's `vite build` and the server's
`tsdown` (`apps/server/tsdown.config.ts` — the workspace packages inlined, every third-party import
left external, and the four files the code resolves off `import.meta.url` laid beside the bundle:
`runner.mjs`, `skills/`, `drizzle/`, the check's worker as a second entry), then the linked backings
package's own build when `packages/cloud-backings/` is present (GRA-38; the paragraph on
`GRAFT_BACKINGS` above); `prod-deps` installs the production dependencies of the server and of every
inlined package flat under `/app/node_modules` (`node-linker=hoisted`, so `typescript6` and
`tar-stream` resolve from the server's directory — and the linked package's third-party dependencies
land there too, since the lockfile the stage is given names them whenever the package is in the
tree); `runtime` is `node:24-slim` as user `graft`, uid 10001 — the sandbox user's uid on purpose, so
drafts sandboxes write into the shared toolbox are the server's to remove. `node dist/index.mjs` is
the server; `node dist/keys.mjs` beside it mints a `.env`'s secrets without pnpm. The linked package,
built, is `/app/node_modules/@graft/cloud-backings`; the open image has no such directory, and the
same Dockerfile lines produce both images.

The compose file runs it as service `graft` on `${GRAFT_PORT:-3000}`, joined to two networks: the
default one, and `sandbox` (`internal: true`, compose-named `<project>_sandbox`) under the alias
`proxy`, which is what `GRAFT_PROXY_PUBLIC_URL=http://proxy:3000/api/proxy` hands a sandbox. The
Docker socket is mounted (arrangement 1 of `packages/sandbox-docker/README.md`; the `docker:dind`
sibling is arrangement 2) with `group_add: ${GRAFT_DOCKER_GID:-0}` for the socket's group. The
toolbox is the named volume `<project>_toolboxes`, mounted at `GRAFT_TOOLBOX_ROOT` and named again in
`GRAFT_TOOLBOX_VOLUME` so the backing mounts each toolbox into its sandbox as a subpath of the same
volume — one tree (`packages/toolbox/README.md`). Service `sandbox` has `scale: 0`: it builds the
sandbox image under the name `GRAFT_SANDBOX_IMAGE` carries and starts nothing. Health checks:
`pg_isready` and `GET /api/health`; `graft` waits for Postgres healthy.

CI builds the image on every pull request and asserts that it refuses to start naming what is missing:
run with no environment, `GRAFT_DATABASE_URL`, `GRAFT_AUTH_SECRET` and `GRAFT_HANDOFF_SECRET`; run with
every field but the keyring secret, `GRAFT_KEYRING_SECRET` — the cross-field rule GRA-20 made of it,
which only runs once every field is present; run with every field under `GRAFT_BACKINGS=cloud`, the
sentence that `@graft/cloud-backings` is not installed — the open image's proof that it carries no
hosted backings (GRA-38), which needs no database because the selector runs before the pool is opened.
`.github/workflows/release.yml` pushes `ghcr.io/getmodern-ai/graft` and `graft-sandbox` on a `v*` tag,
for `linux/amd64` and `linux/arm64`. The conformance suite against a running compose project is
`packages/sandbox-docker/src/compose.test.ts`, opt-in by `GRAFT_COMPOSE_NETWORK` and
`GRAFT_SANDBOX_IMAGE`; its header has the command.

The working-set sweep (ADR 0009) runs inside the server on a plain timer, every
`GRAFT_SWEEP_INTERVAL_SECONDS` (default 300): per agent it demotes what went unused past the idle
window, then the least recently used beyond the cap — never a tool used inside the window, and never
while the agent has a run in flight — and fires `tools/list_changed`. Each demotion is a
`working_set_change` row with cause `idle` or `cap`, which `GET /api/agents/:id/working-set/changes`
reads for the console. The rule itself is `packages/core/src/working-set/sweep.decision.ts`, a pure
function; `packages/mcp/src/sweep.ts` applies it. `pnpm --filter @graft/server sweep -- --plan`
prints what a sweep would do without doing it; without `--plan` it demotes, from a process that can
neither see a running server's in-flight runs nor notify its sessions, so use that form with the
server stopped.

### The console

`apps/web` (`@graft/web`, GRA-26) is the console (CONTEXT.md, *Console*; ADR 0006): React on Vite,
TanStack Router with file routes and Query, Tailwind 4, and Cando's primitives copied into
`src/components/ui` over Base UI (GRA-45). There is deliberately no `packages/ui`: one SPA does not
warrant a second workspace. **The primitives are Cando's files, not the registry's.** Each is
`packages/ui/src/components/<name>.tsx` at Cando's `origin/main` with four import rewrites —
`@cando/ui/lib/utils` → `@/lib/utils`, `@cando/ui/components/icons` → `@/components/icons`,
`@cando/ui/hooks/use-mobile` → `@/hooks/use-mobile`, `@cando/ui/components/<x>` →
`@/components/ui/<x>` — a comment that names a Cando app file qualified as Cando's, and where a
file has to deviate, a comment on the spot naming why (today only `kbd.tsx`'s `KbdGroup` props).
Do not run `npx shadcn add` over them: the registry's base-lyra output is what they replaced,
and it would put `rounded-none` and `text-xs` back. To re-sync one, `git show
origin/main:packages/ui/src/components/<name>.tsx` in the Cando checkout, apply the same rewrites,
and read the diff; a local deviation carries a comment naming why. Not every Cando primitive is
here — the product-specific ones (bloom faces, dot sprite, bubble, message, attachment, chart,
calendar, carousel, combobox, command, inline-edit) are not ported, and the rest arrive as a screen
needs them; `src/hooks/use-mobile.ts` came with `sidebar.tsx`, and its colocated test pins the
breakpoint against `index.css`. Biome excludes the generated `src/routeTree.gen.ts` and switches a
few rules off for `src/components/ui/**` — the primitives' own shape trips them, and Cando does the
same for its `packages/ui`.

**The console is drawn with Cando's design system** (ADR 0017, GRA-44). `src/index.css` is Cando's
`globals.css` with the product-specific pieces left out — its header says which and why — and the
values between the `cando:tokens:start`/`end` sentinels are copied whole from Cando's managed block,
never edited here; Figma stays upstream in Cando. There is no design file for the console, so a
screen is composed from the system's patterns and its pull request carries a delta list saying what
was composed from what and where it departs. Icons are Material Symbols generated into
`src/components/icons.tsx` by `scripts/generate-icons.mjs` — add a glyph to `NAMES` there and run
`pnpm --filter @graft/web generate-icons` then `pnpm run check`; there is no `lucide-react`. The theme
is `next-themes` through `src/components/theme-provider.tsx`, mounted in `routes/__root.tsx` with
Cando's four settings (class attribute, `system` default, `vite-ui-theme` storage key);
`src/components/ui/sonner.tsx` is Cando's theme-aware `Toaster`, the first primitive copied (under
GRA-44, because sonner does not read the `.dark` class). The two `theme-color` hexes — in `index.html`'s metas and
in `theme-provider.tsx` — are the only colours written as literals on purpose, and both are entries
in `COLOUR_EXCEPTIONS`. Two guards keep dark mode correct and CI runs both as their own steps:
`pnpm run check-colours` (a hard-coded colour in a component or in `index.html`, a colour literal
inside `@theme`, a base token left behind by its family — logic in `src/tokens/*.ts`, exceptions in
`COLOUR_EXCEPTIONS` there and never inline) and
`pnpm run check-tokens` (every design-token utility compiles into `dist/assets`; it needs a build,
which `check-types` runs). GT Standard L and GT Standard Mono VF ship with the console: the six
`.woff2` files under `src/fonts/` and Cando's `@font-face` block in `index.css`, byte-identical to
Cando's, under the Grilli Type licence Aleks confirmed covers Graft (GRA-49).

**What the console composes for itself from the primitives** (GRA-45). `src/components/code-block.tsx`
is the one place a token, a shell line or an ask's raw payload is shown: a label row with
`CopyButton`, the text on the muted band in the mono stack, an optional hint — Cando has no code
block, so this is composed from its tokens rather than copied. A destructive confirmation is an
`AlertDialog` in Cando's shape, and `components/agent/revoke-agent-dialog.tsx` is the reference: a
question for the title, the blast radius in the description, `AlertDialogCancel` first in the DOM,
the destructive `AlertDialogAction` last with a present-participle label while pending, both
disabled while it is, and close requests ignored until the mutation settles. A choice among fixed
options is the `Select` primitive with `items` on the root, so the closed trigger shows the option's
label — never a raw `<select>`. **Every status chip comes from `src/lib/status-chips.ts`** (GRA-47):
one map per vocabulary — agent, connection, call outcome, approval, working-set change, model key,
tool annotation — to `{ variant, label }`, drawn through `components/status-chip.tsx`, so a call
site never picks a tone or spells a label. The rule the map encodes: `success` for a state in which
the thing works (`Connected`, `Allowed`, an `OK` call, an `Active` agent, a key that is `Set`),
`destructive` for one that will not until someone acts (`Revoked`, `Denied`, `Error`, `Needs
re-consent`), `outline` for waiting on something (a credential, a consent, a reconnection), and
`secondary` for the neutral rest; `ToolAnnotations` reads its three from the same file. Labels are
sentence case, like every label in the console, and its colocated test pins both.

**Screens follow Cando's patterns** (GRA-47). Every list is a `DataTable layout="grid"` with the
column widths declared on `TableHead` — a mobile width and an `md:` one, the prose column left
auto — and `DataTableRow` for the 40px rhythm; a column the row cannot afford at 390px steps out
(`hidden md:table-cell`) and, where it is the row's one load-bearing fact, follows the name in muted
text instead. Loading, empty and failed are rows *inside* the body, never a spinner or a block
beside the table: `components/table-body-states.tsx` holds `TableLoadingRows` (one full-span
skeleton per row) and `TableBodyNote` (one full-span sentence), and the failed note carries
`components/retry-notice.tsx`, Cando's inline Retry. A table owns its read (`useQuery`, not the
suspense form) so those states are reachable; the agent page's loader awaits the agent and only
*starts* the table reads, so the page paints once with skeleton rows. Connections stay cards —
each carries a status, hosts, tools, two actions and a table — with Cando's card anatomy, and the
recent calls are a disclosure in the body, not the banded `CardFooter`. A notice inside a form is
an `Alert`; a labelled control with a sentence beside it is an `Item` (`components/ui/item.tsx`,
ported with the rest); nothing draws its own `rounded-* border` frame. The settings screen is
Cando's row family, ported to `components/settings/` — `SettingsSection` (an `h2`), `SettingsCard`,
`SettingsRowGroup` with inset dividers, and the `SettingsRow` variants — with one section, Model,
carrying the key's behaviour as rows. A failed **query** toasts once with a working Retry
(`lib/query-error-retry.ts`, keyed to the query hash so a second failure replaces rather than
stacks, dismissed on the next success) beside the mutation toast; a read that fails before a screen
draws toasts *and* shows the route boundary, as Cando's does. A screen-level empty is the `Empty`
primitive without a frame of its own, in Cando's voice — sentence-case title without a full stop,
one sentence whose clause after the dash is reassurance — and an in-card empty is one muted
sentence. `PageContainer` gaps: `gap-4` under the header of a list screen, `gap-6` on a detail or
settings screen with several regions, as Cando's connections and settings screens pass them.

**Same-origin with the API, in both forms.** `pnpm --filter @graft/web dev` (or `pnpm run dev`, which
starts the server too) serves the app on `:3001` with Vite proxying `/api` and `/mcp` to
`GRAFT_SERVER_URL` (default `http://localhost:3000`), and in production `apps/server` serves
`pnpm --filter @graft/web build`'s output from `GRAFT_CONSOLE_DIR` (default `../web/dist`, relative
to the server's working directory) with an SPA fallback (`apps/server/src/console.ts`). The session
cookie therefore never crosses an origin; `GRAFT_CORS_ORIGIN` remains for a console served from
elsewhere. A server whose console directory holds no build boots and answers every console path with
a JSON 404 saying where it looked. `GRAFT_CONSOLE_URL` is a different setting: where handoff URLs
point (GRA-23), which in development is the Vite origin.

**The shell is Cando's, less the agent rail** (GRA-46). `src/components/shell/app-shell.tsx` mounts
the `Sidebar` primitive off canvas at its own 16rem — the `sidebar_state` cookie it writes is read
back by `src/lib/sidebar-state.ts`, ⌘B toggles it, and below `md` it is the drawer, closed on the
router's `onBeforeNavigate` — with `SkipNav` first in the tree and the `<main>` region carrying
`MAIN_CONTENT_ID`. `main-sidebar.tsx` draws the mark (`src/components/graft-mark.tsx` — the wave mark getgraft.ai and
the docs carry, drawn in tokens; GRA-97), the four destinations from `src/lib/main-sidebar-nav-items.ts` (a pure data
module, tested) with the open-ask count as a `SidebarMenuBadge` and the count in the link's own
name, and `account-menu.tsx` at the foot: name and email, the Theme radio group (label *inside* the
group — Base UI's `Menu.GroupLabel` throws outside one), Sign out through `src/lib/sign-out.ts`,
which removes the session entry and clears the cache before anyone navigates. The screen's title is
written once, with `useScreenTitle` (`shell/screen-title.tsx`), and shown by two bars — the 48px
`PageNav` strip at `md` and up, which also carries `PageNavCollapsedSidebar`, and `MobileTopBar`
below it; the strip is mounted once in the shell rather than per screen as in Cando, for the
reason that file gives. Every screen is a `PageContainer` (`large` for the agents table and the
agent detail, `medium` for the card stacks and settings) opening with `PageHeader`; a detail screen
titles the bars with `PageNavBreadcrumb`. The doors share `AuthHeader` and `AuthCard` (`max-w-md`,
the `xs` container inside); `route-not-found.tsx`, `route-error.tsx` and `loader.tsx` are Cando's.
Not here, because Graft has none of it (ADR 0017): the agent rail and its faces, the New Thread
button, the Automations and Recents groups, and the settings shell with its own sidebar.

The shape is Cando's: `routes/_auth/route.tsx` is the guard and only the guard (a signed-out visit
goes to `/login?redirect=<same-origin path>` and returns there, which is how a handoff URL survives a
fresh browser); `routes/_auth/_shell/` is the chrome; a screen's file placement decides both. Three
screens sit outside both — the two doors, and `routes/oauth.callback.tsx`, where the server's OAuth
callback sends the popup (GRA-48): it has no session to wait on, no chrome to wear, and everything
it shows is in its query. `routes/_auth/_shell/consent.tsx` is the other consent — an MCP client's
(ADR 0018) — and sits under both: the guard, so a chat product's "connect" reaches a person with no
session by way of sign-in and back, and the shell, because it is a screen of the console like any
other; `components/agent/consent-card.tsx` is its form, composed from the create-agent dialog's.
`src/lib/*-queries.ts` hold the query options and mutations per aggregate, `src/lib/api.ts` is the
one `fetch`, and every wire type is imported from `@graft/server/api`, `@graft/core`, `@graft/db` or
`@graft/mcp` and passed through `Jsonified<T>` — never written a second time. The pending-actions
page dispatches on the ask's `kind` in `components/pending/pending-action-card.tsx`, one card file per
kind, so a new kind is one branch and one file. Components carry no tests; the pure helpers under
`src/lib` do, and `check-types` runs `vite build` first so a broken bundle fails CI as a type error
would.

**The connection form reaches into `@graft/core` and `@graft/proxy` at run time, and three modules
stay browser-safe for it** (GRA-28): `packages/core/src/connection/connection.rules.ts` is what the
form validates with — the same functions the connection service applies at create and the
`request_connection` meta-tool applies to an agent's proposal, so a private, link-local or
cloud-metadata host is refused with the reason `host_not_public` in all three places and again by the
proxy at resolution — and `packages/proxy/src/credential-fields.ts` and `scheme-parameters.ts` are the
two halves of the scheme table the form renders its secret and parameter inputs from. Each imports
nothing but the others and a type; an import of `@graft/proxy`'s index or of a repo in one of them
pulls `node:crypto` or drizzle into the bundle, and `vite build` is what fails. Add a scheme by adding
to both tables and the plugin, never to the form.

**The console has two doors, and registering opens no session until the address is verified**
(ADR 0020 as amended, GRA-81, GRA-94): `/login` signs in only and `/signup` registers, both Cando's
sign-in card — the email, then the password beneath it in the same card, a *Continue with Google* /
*Continue with GitHub* button under *Or* for each provider the server names at
`GET /api/sign-in-methods` (public), and a cross-link to the other door carrying `redirect`. A
sign-up answers "check your email" whether the address is new or taken; the inbox tells them apart
(`@graft/email`'s `emailVerification` and `accountExists` templates), the emailed link verifies,
signs in and returns to `/login`, and an unverified sign-in re-sends the link. The pure decisions
are `apps/web/src/lib/auth-attempt.ts` (every auth call made total over a network failure, with
tests) and `email-auth-outcome.ts`. The providers are `GRAFT_GOOGLE_CLIENT_ID`/`_SECRET` and
`GRAFT_GITHUB_CLIENT_ID`/`_SECRET`, each pair all-or-nothing and off by default
(`packages/env/src/schema.ts`, `signInProvidersFrom`), handed to `createAuth` as `socialProviders`;
the redirect URI is `GRAFT_AUTH_URL` plus `/api/auth/callback/<provider>`. A social sign-in links
to an existing account only when both the provider and the account vouch for the address — which,
with verification on, every new password account does. The admin the self-hosted image opens from
its environment is marked verified by the boot (`markPersonEmailVerified` in `@graft/db`, unscoped
and pinned as such), since the operator typed that address. The provider marks are flat `.svg`
files under `apps/web/src/assets`, outside the colour guard on purpose, as Cando's are.

**A forgotten password is reset by email, and mail is a seam** (ADR 0021; GRA-82, GRA-90):
`@graft/email` is Cando's `@cando/email` less the invitation and less the vendor — a transport
seam (`EmailTransport`, one `SendResult` shape), a registry naming the one template's variables
and subject, and the façade. The open form's backings are the SMTP transport (GRA-92) — on when the
all-or-nothing pair `GRAFT_SMTP_URL`/`GRAFT_MAIL_FROM` is set, sending through the self-host's own
relay and rendering each template itself from `RENDERERS` in `packages/email/src/smtp.ts` — and,
unset, the console transport, which prints the envelope and the reset link into the server's log,
so `docker compose logs graft` is where a fresh self-host's reset link is. The hosted form's transport
is a vendor's and lives in the private package, which answers `mail` beside the other seams
(`Backings.mail` in `apps/server/src/backings.ts`); no vendor, template id or mail variable
appears in this repository. `createAuth`'s `passwordReset` option binds the hook; the link is
`GRAFT_CONSOLE_URL` plus `/reset-password?token=…`. The screens are `/forgot-password` (the same
answer whether or not an account exists) and `/reset-password` (`apps/web/src/lib/reset-password.ts`
decides the dead-link state and folds the outcomes, with its test); *Forgot password?* is on the
door's password step.

### Running `acquire` locally

`acquire` is the loop (ADR 0004): the meta-tool creates a job and the in-process runner
(`@graft/mcp`'s `acquire/runner.ts`, GRA-29) works it — reads the documentation, drafts, checks,
proves with reads, publishes, dry-runs, retries, promotes. **A job's publish moves no pointer**
(GRA-77): it publishes with `activate: false`, dry-runs the version by id, and on the pass calls
`@graft/core`'s `activateToolVersion` — definition and pointer, one transaction — before promoting,
so `authored_tool.current_version_id` names only a version that passed its dry run (ADR 0012, L0 as
amended 2026-09-17); a job that never passes leaves a tool with no current version, which `find_tool`
omits and `promote` and a run refuse as `tool_has_no_version`. The dry run runs the version against the
job's connection, never the tool row's default, and the publish rebinds an existing row to it when
the row's default is revoked (GRA-122; the paragraph *A tool follows its vendor's reconnected
connection* above). The runner is the second plain scheduler
beside the sweep: `GRAFT_ACQUIRE_CONCURRENCY` (default 2) jobs at once, kicked by the meta-tool and
polling for what a previous process left queued or running with a stale heartbeat. Each job is bounded
by `GRAFT_ACQUIRE_MAX_ATTEMPTS` (default 4 — every draft is an attempt, a check refusal included) and
`GRAFT_ACQUIRE_TOKEN_CEILING` (default 400000 tokens across every model turn); a job that hits either
ends with a result naming it. Every attempt is an `acquire_attempt` row, every step an `acquire_trace`
line, redacted on the way in (`@graft/core`'s `redaction.ts`; the proxy redacts an echoed credential
by value before that, ADR 0010 amended).

Which model answers is `GRAFT_MODEL_BACKEND` (`apps/server/src/model.ts` chooses at boot). Unset, the
server boots with no model and `acquire` refuses `acquire_unconfigured`. `scripted` plays a JSON file
of canned answers, one per situation the job puts (`@graft/model/scripted`, `parseScript` has the
shape), for driving the whole loop on a laptop with no provider key; it needs `GRAFT_MODEL_SCRIPT=<path>`
beside it and is refused in production. `provider` is the real thing (`@graft/model/provider`, GRA-31):
one strong coding model authors and one cheap model triages — decides whether the job opens with a
round of documentation, condenses a long page before it enters the authoring context, never writes
code — through the AI SDK, with `GRAFT_MODEL_PROVIDER` (`anthropic` | `openai`) and
`GRAFT_MODEL_API_KEY` read together under it and refused outside it. `GRAFT_MODEL_AUTHORING` and
`GRAFT_MODEL_TRIAGE` default per provider — Anthropic `claude-fable-5-1` / `claude-haiku-4-5-20251001`,
OpenAI `gpt-5.6-sol` / `gpt-5.4-mini`, the OpenAI pair confirmed against the live models list on
9 September 2026 — and `GRAFT_MODEL_BASE_URL` points the OpenAI provider at an OpenAI-compatible
gateway, which also selects Chat Completions over Responses. The model answers in the `ModelAnswer`
shape through structured output; an answer the job could not use goes back once, with the problems
named, before the job records `model_failed`. **The self-hosted form refuses to boot without it**
(ADR 0014): `NODE_ENV=production` under `GRAFT_BACKINGS=open` needs `GRAFT_MODEL_BACKEND=provider` with
the provider and the key, and the boot names both.

**A person's own key** (ADR 0014) is `person_model_key`: one row per person, the key envelope-encrypted
under the person's model-key scope through the vault's encrypt half, write-only after entry.
`GET`/`PUT`/`DELETE /api/me/model-key` are the console's routes, behind the Settings screen; `model.ts`
decrypts a key in the one place outside the proxy binding and puts the person's provider in front of
the fixed model, so their jobs — and the vendor documentation those jobs read — go to their provider
and nobody else's (`apps/server/src/model.test.ts` proves the isolation through the service seam).
Routing applies whenever a fixed model exists, and always under `cloud`; under `open` with no fixed
model `acquire` refuses at the door rather than accepting a job that fails for want of a key.

**Observability is three seams with no backing in the open form** (GRA-100; ADR 0002 as amended
2026-09-19; `@graft/observability`): the **log drain** (`LogDrain`) — where a wide event goes after
stdout; the open form's stay on stdout, the hosted form's drain is handed to `initLogger({ drain })`
on the logger rather than the Hono middleware, so the acquire runner's and the sweep's own `log`
lines drain beside the requests' — **analytics** (`Analytics`, `NO_ANALYTICS`, the event vocabulary
in `events.ts`: `noun_verbed`, counts and kinds, never content) and **model telemetry**
(`@graft/model`'s `ModelTelemetry` and `NO_TELEMETRY`, the backing as `ModelTelemetryBacking`).
`Backings` carries the three and the boot line names each: `logs stdout, analytics off, model
telemetry off` on every self-host. Every `POST /mcp` event carries the tool call under `mcp` — the
tool, its kind, the agent, the person, the outcome, the refusal's reason, the latency — from
`McpDeps.onToolCall`, which `tools.ts` fires once per call from its one dispatch point; the runner's
and the sweep's lines ride under `acquire` and `sweep`. Product events are captured server-side at
two chokepoints and nowhere in the console: the API's mutation routes
(`apps/server/src/analytics-routes.ts`, one table from method and path to event) for what a person
does there, and the MCP hook and the acquire runner for what happens over MCP (`tool_called`,
`acquire_completed`, `acquire_failed`); both name the person by id. The vendors behind the hosted
form and their variables are graft-cloud's, in its private package's `observability/` and `env.ts`.

```bash
cat >> apps/server/.env <<'ENV'
GRAFT_SANDBOX_BACKEND=fake
GRAFT_MODEL_BACKEND=scripted
GRAFT_MODEL_SCRIPT=./acquire-script.json
ENV
```

A script for a public API the proxy can reach without a real key — the connection still needs *a*
credential entered, since the scheme injects one — is the shortest by-hand proof: `goal` →
`write_module` with a `ctx.fetch` of a documented `GET`, `proofReads` naming the same path, and a
`testInput`. `acquire { connectionId, goal }` over MCP answers `{ jobId, status, progress }`;
`acquire_status { jobId }` answers the progress lines and, at the end, `result` — the tool's wire name,
version and annotations, or `{ failure, message, lastDiagnostics, tried }`.

### The evals

`packages/evals` (ADR 0012: the eval suite is the gate; GRA-31) runs the real loop against two fake
vendors behind the real proxy with the provider-backed model and grades what it did with deterministic
scorers: reads before publish, publish before the first write, no vendor host in the model's code, a
dry run before any ask, the first write through the published tool, and the supporting facts. It is an
app-like leaf nothing imports, which is what keeps it out of the server's Docker image
(`apps/server/Dockerfile`'s `prod-deps` installs `--filter "@graft/server..."`); a server dependency on
it would pull it in.

```bash
pnpm --filter @graft/evals eval                      # every scenario; needs GRAFT_MODEL_PROVIDER + GRAFT_MODEL_API_KEY
pnpm --filter @graft/evals eval -- --scenario write  # one by name
pnpm --filter @graft/evals eval -- --scripted        # the harness's own test: canned answers, no key, no spend
```

Without a provider it says what is missing and exits non-zero before opening anything. `pnpm test`
runs the scorers and the scripted harness test on every commit and never reaches a provider.
`packages/evals/README.md` has the scorers and how the SDK scenario runs on the fake sandbox.

### The Hermes skill

`skills/hermes-graft/SKILL.md` (ADR 0016; MIT under `skills/LICENSE`) is the thin skill a Hermes person
installs: when to call `acquire`, how to relay a handoff, how to describe an approval, what
`acquire_status` means while a job runs, and the `mcp_servers` block with the agent token in
`~/.hermes/.env`. Nothing else is installed into the harness; `skills/hermes-graft/README.md` says how.

### Publishing a tool by hand

The publish (`@graft/publish`, GRA-18) writes a version into the person's toolbox — a directory tree
under `GRAFT_TOOLBOX_ROOT`, default `./.graft/toolboxes`, one subdirectory per person
(`packages/toolbox/README.md` has the layout and how the tree meets a sandbox's mount). A module can
be published from a directory without the MCP server:

```bash
pnpm --filter @graft/server publish-fixture -- --dir ../../packages/publish/fixtures/hello \
  --vendor demo --name hello --description "Greets a name" --email you@example.com --password '…'
```

A module that declares packages needs the Docker backing for ADR 0013's install step:
`GRAFT_SANDBOX_IMAGE` (`pnpm --filter @graft/sandbox-docker image:build` makes `graft-sandbox:dev`)
and `GRAFT_SANDBOX_NETWORK` (an `internal` network, `docker network create --internal graft-sandbox`),
all-or-nothing. Without them the publish refuses such a module with an `install-failed` diagnostic
saying so. `left-pad` in `packages/publish/fixtures/left-pad` is not an official SDK, so admitting it
is `GRAFT_PACKAGE_ALLOWLIST=left-pad`; `GRAFT_PACKAGE_MIN_AGE_DAYS` and
`GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS` are the policy's other two knobs.

`check-types`, `test`, `build` and `dev` are Turbo tasks, so they run whatever a workspace declares
under that script name and nothing for a workspace that declares none. Filter with
`pnpm exec turbo run <task> -F @graft/<name>`. `pnpm run test --force` skips Turbo's cache; read
the summary and confirm `Cached: 0` when a green run is the evidence you are after.

### Adding a package

A workspace is a directory under `packages/` or `apps/`; `pnpm-workspace.yaml` globs both, so no
file is edited to add one. Copy the shape of `packages/core`:

- `package.json` with `"type": "module"`, `exports` pointing at `./src/*.ts` (packages ship source;
  `tsx` and Vite compile it, so there is no build step), and `check-types` and `test` scripts so
  Turbo picks the package up.
- Shared dependency versions come from the `catalog:` in `pnpm-workspace.yaml` (`typescript`,
  `@types/node`, `vitest`); add a line there rather than pinning a second copy of a version.
- `tsconfig.json` extends `@graft/config/tsconfig.base.json` and sets `noEmit`; the base is strict,
  ESM with `moduleResolution: bundler`, `verbatimModuleSyntax` and `noUncheckedIndexedAccess`.
- Tests are Vitest, colocated as `<unit>.test.ts` beside the unit, and services are designed to run
  without a database.

## Conventions carried over from Cando, until this repo has its own

Biome for formatting and linting: two spaces, one hundred columns, double quotes, `noFocusedTests`
at `error` because `biome ci` exits 0 on a warning and an `it.only` would otherwise pass the
required check. `.agents/skills` is excluded from Biome because vendored files answer to their
upstream. `.claude/worktrees` is excluded root-relative on purpose: a `**/` pattern matches the
*containing* path too, so running Biome inside a checkout that sits under a `worktrees/` directory
would exclude the whole checkout and lint nothing (Cando's CAN-147; reproduced here before writing
the pattern). Skills for the vendored engineering workflow will be added now that there is code to
work on.

## Conventions

- **One pnpm override, for a Dependabot alert, not a preference.** `@esbuild-kit/core-utils>esbuild` is
  pinned to the 0.25 line under `overrides:` in `pnpm-workspace.yaml` because drizzle-kit's ESM loader
  still depends on `@esbuild-kit/core-utils`, which resolves `esbuild@0.18`, and esbuild below 0.25
  lets any website reach its development server (GRA-41). Nothing here runs esbuild's serve mode, so
  the exposure was theoretical; the override exists so the alert closes. Drop it when drizzle-kit
  stops depending on `@esbuild-kit` (`pnpm why @esbuild-kit/core-utils` says whether it still does).
  It is in the workspace file rather than under `pnpm` in the root `package.json` because pnpm 11 no
  longer reads that field and warns on every command that it ignored `pnpm.overrides`, while pnpm
  10 — the line `packageManager` pins, and what an 11 on a laptop delegates to — reads both places,
  so the workspace file is the one placement both lines honour.
