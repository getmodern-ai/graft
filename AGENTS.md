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

## Skills

Content lives in `.agents/skills/<name>/SKILL.md`; `.claude/skills/*` are symlinks to it, so a
skill is authored once and Claude Code and Codex read the same copy. Always edit the file under
`.agents/`, never through the symlink directory.

Presence in `skills-lock.json` marks the boundary: a listed skill is **vendored** from an upstream
source and pinned by content hash, so a local edit is lost on the next sync. Today every entry is
one of [`mattpocock/skills`](https://github.com/mattpocock/skills), all thirty-eight of them,
vendored whole under MIT (`.agents/skills/LICENSE` is his notice; GRA-179). Taking a subset was
tried in Cando and abandoned: they cross-reference heavily, so any subset leaves the flows they
describe dead-ending on skills nobody installed. A skill of our own would go beside them and stay
out of the lockfile; there is none yet, and the Hermes skill under `skills/` is a product, not a
skill for working here.

Biome does **not** look inside `.agents/skills` (`biome.json`): vendored files answer to their
upstream, and in Cando the reformatting reappeared on every sync until the exclusion.

### Keeping them current

```bash
npx skills update -p -y                  # refresh everything already in the lockfile
npx skills add mattpocock/skills         # pick up skills that did not exist when we last looked
```

`update` iterates `skills-lock.json`, so it can only refresh what is already listed; a skill
published upstream after our last `add` is invisible to it. Three things to know, the first two
from Cando's experience of the same CLI and the third reproduced here on 2026-09-22:

- **`matt-code-review` cannot auto-update.** The CLI resolves the upstream skill by its *local*
  name rather than by `skillPath`, so it looks for `matt-code-review` in his repository, finds
  nothing, and reports a failure. Nothing is damaged, but it receives no upstream changes. To
  refresh it by hand, `add` it under its own name somewhere disposable and copy the file across,
  then put the `name:` line back.
- **`update -p` updates *every* vendored skill.** Run it deliberately, in a pull request about that.
- **On a laptop with `~/.openclaw`, `update` links the skills into the root `skills/` directory.**
  The CLI relinks every agent it detects as installed, and its OpenClaw definition names the bare
  `skills/` as that agent's project directory, which here is the Hermes skill's home (MIT,
  `skills/LICENSE`). They show up as untracked `skills/<name>` symlinks; delete them before
  committing (`find skills -maxdepth 1 -type l -delete`) and never commit them. Install only ever
  named `claude-code` and `codex`, so a fresh `add` does not do this.

### Which to reach for

**Start with `/ask-matt`.** It is the router over the rest and holds the map: which skill opens
which flow, where the on-ramps merge, and where a phase boundary makes it safe to compact.
Reproducing that map here would let the copy rot. The main path, for orientation:

```
grill-with-docs → to-spec → to-tickets → implement → matt-code-review
                                           ├ tdd
                                           └ diagnosing-bugs
```

with `/triage` on-ramping raw incoming issues, `/diagnosing-bugs` on-ramping breakage,
`/wayfinder` for an effort too foggy to hold in a single session, and `/implement-spec` when a
whole spec's ticket graph is to land on one branch. One rule from `ask-matt` worth knowing before
you read it: keep grilling, spec and tickets in **one unbroken context window** (don't compact
until after `/to-tickets`) so all three build on the same thinking;
`.agents/skills/ask-matt/PHASE-BOUNDARIES.md` says where compaction is safe.

Four are here for completeness rather than use: `scaffold-exercises` and `migrate-to-shoehorn`
target his course repositories, and `setup-pre-commit` and `git-guardrails-claude-code` would
install tooling this repository has deliberately not adopted (Biome, not Prettier plus Husky);
the guard script's substring match also misses `git -C <dir> push`, so it would not be the
protection it says it is (Greptile on #137). `improve-codebase-architecture` writes an HTML report
that loads Tailwind and Mermaid from public CDNs, so the file names and module shape it draws are
shown to those scripts when it is opened; fine for this public repository, and worth knowing before
running it over a private checkout that links `packages/cloud-backings/`.
`/pr` proposes a body shape (Summary, Evidence, Merge Danger) that is a fine skeleton, but the
body of a pull request here is the build record *Before anything else* describes, and that content
comes first.

**Why `matt-code-review` and not `code-review`.** Claude Code ships a built-in `code-review`, and
the built-in wins the name; his was installed and simply unreachable in Cando. So it is aliased:
the directory, the lockfile key and the frontmatter `name` all say `matt-code-review`, while
`skillPath` still points at `skills/engineering/code-review/SKILL.md` upstream. The two answer
different questions: the built-in finds correctness bugs and simplifications in a diff and can post
inline comments; his checks a branch against documented standards *and* against the ticket that
asked for it, in parallel sub-agents. One consequence: `implement`, `implement-spec` and `ask-matt`
end with "use `/code-review`", which resolves to the built-in. Reach for `matt-code-review` by hand
when you want the spec axis, and do not edit the vendored files to fix it.

**These skills assume an issue tracker, and ours is Linear, not GitHub Issues.** They default to
`gh issue create`. The real workflow is recorded in `docs/agents/` (the **Agent skills** section
below). Read it before using `triage`, `to-tickets`, `to-spec` or `wayfinder`, or they will reach
for the wrong CLI.

> **Leave "PRs as a request surface" set to `no`.** It is recorded that way in
> `docs/agents/issue-tracker.md`. `triage` step 3 verifies a PR by checking it out and running its
> tests, which for a PR from outside the organisation means executing contributor-controlled code
> in a session holding credentials. This repository is public and takes outside contributions, so
> the flag is load-bearing here in a way it was not in Cando. It cannot be fixed by editing
> `triage/SKILL.md`; that file is vendored.

## Agent skills

Per-repository configuration the vendored engineering skills read. `setup-matt-pocock-skills`
would write these; here they were written by hand from Cando's (GRA-179), so edit the files
directly rather than running it, unless you are switching trackers outright. *Agent* in that
directory means the coding agent; everywhere else it is `CONTEXT.md`'s word.

- **Issue tracker**: Linear, in the Graft team, through the MCP server configured in the person's
  own tooling. Work groups initiative → project → issue; a spec's tickets go in the spec's project
  as sub-issues. `docs/agents/issue-tracker.md`, which also carries the "PRs as a request surface"
  flag, the pull-request rules and the Linear equivalents of the wayfinding operations.
- **Triage labels**: the five canonical roles, unaliased: `needs-triage`, `needs-info`,
  `ready-for-agent`, `ready-for-human`, `wontfix`. All exist in the Graft team. They are a *state*
  axis and compose with the type labels (`Bug`, `Feature`, `Improvement`, `Infra`).
  `docs/agents/triage-labels.md`.
- **Domain docs**: single-context, one `CONTEXT.md` and one `docs/adr/` at the root, despite the
  monorepo. `docs/agents/domain.md`.

## Working agreement

- **Every pull request has a Linear ticket** in the Graft project, and the PR references it.
- **`main` is protected.** Branch, push, open a PR. Merging needs one approving review, a green
  `Typecheck, Lint & Test` check, and a clean Greptile review; Greptile reviews every PR and edits
  its comment in place, so check the SHA it says it reviewed.
- **Every commit is signed off**, a merge commit included. `git commit -s` writes the
  `Signed-off-by` line the `DCO` workflow looks for, `git merge --signoff` signs a merge, and
  `git rebase --signoff origin/main` adds it to a branch already written.
  A Developer Certificate of Origin replaced the CLA on 2026-09-21 (ADR 0022); the core is
  Apache-2.0 and `CONTRIBUTING.md` is what an outside contributor reads.
- **`SECURITY.md` is what the outside is told.** Where to report a vulnerability, what is in
  scope and where the design is written down; a change that moves one of those boundaries
  (the proxy, the token, the vault, the sandbox, the asks, the MCP OAuth server, the console's
  session) updates that file in the same pull request.
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
  a `GRAFT_*` variable, ask whether it is a vendor's; if it is, it goes there. The last exception,
  the hosted form's link provider, moved there under GRA-103.

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
pnpm run db:start      # postgres:18 alone, plus docker-compose.dev.yml, on 127.0.0.1:5432 (GRAFT_POSTGRES_PORT overrides)
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
  The four `db:*` compose scripts pass `-f docker-compose.yml -f docker-compose.dev.yml`, because
  that overlay is the only thing that publishes Postgres on the host, and on loopback alone
  (GRA-148): `docker compose up -d` publishes no database, and the `graft` service reaches it by
  name on the project's own network.
- **Everything in containers** (`docker compose up -d --build`) — to see the image a self-hoster
  gets, or to run the loop end to end with Docker sandboxes and no host setup. `.env` at the root
  (from `.env.example`) holds its secrets, model key and admin. **No secret has a default**, in
  that file or in the compose file: `node dist/keys.mjs` mints the five Graft refuses to start
  without and `GRAFT_ADMIN_PASSWORD` with them (GRA-148), and the operator types
  `GRAFT_ADMIN_EMAIL`.

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
pnpm --filter @graft/server keys >> apps/server/.env    # key pair, keyring, auth and handoff secrets, and the admin's password
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
The password is the keys script's, never a file's: `@graft/env` refuses one under 16 characters,
one this repository once shipped and one still holding a secret store's placeholder, each with a
sentence naming the variable (GRA-148).

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
host of their registered redirect URIs, and is the whole of that rule (GRA-84, GRA-150; the
paragraph on the card below). `GRAFT_PROXY_MAX_BODY_BYTES` (default 10 MiB, floor 1 MiB) is the
proxy's body cap on both legs, passed into the proxy's options beside `followRedirects` and named on
the boot line only when raised (GRA-183; ADR 0010). `packages/env/src/schema.ts` is the rules as
code.

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
GRA-57). `Backings.providers` is an ordered list — under `open` the keyring alone (the gateway ahead
of it when configured), under `cloud` the gateway when configured, then whatever the private package
answers, with the keyring appended last — and the boot line names them (`providers keyring`). A
provider (`packages/core/src/connection/provider.ts`) decides how a vendor gets connected (`form`
over the proxy's schemes, `link`, or `none`), how a call resolves (`inject` the row's credential, or
`relay` through an upstream that holds it), and what to release on revoke; `request_connection`
routes a proposal to the first provider that covers it — a `none`-scheme proposal past every link
provider, to the keyring's keyless confirmation (GRA-166) — and the proxy's connection read
(`apps/server/src/connections.ts`) asks the row's provider how the call resolves. **Coverage is
async** (GRA-126): `covers(vendor, hosts)` and a link's `target` answer a promise, because a hosted
provider decides coverage by asking its vendor's catalogue — which vendors it connects and at which
hosts — and caches the answer; the keyring and the gateway resolve at once, and `providerFor` awaits
the providers in order, asking nobody after a yes. The relay engine is `packages/proxy/src/relay.ts`:
a relay plugin rewrites the resolved vendor request into the upstream's under `RelayHeaderRules` as
data, and `relay.test.ts` drives it through an in-process upstream. There is no catalogue of
plugins: the proxy takes the plugin from the connection's resolution (`ProxyRelay.plugin`), the
gateway's from `gateway-relay.ts` (GRA-58) and a hosted provider's from beside itself in the private
package. `RELAY_SCHEMES` names two: `gateway`, and the generic `relay` every other relay provider's
rows carry (GRA-103; migration 0010 moved the rows the first hosted relay provider wrote under its
own name onto it). A row of a relay provider records its relay scheme in the `scheme` column, and the
enum pin in `packages/core` covers both lists — so `connectionScheme` carries `gateway` and `relay`,
which no form, proposal or credential entry accepts (`connection.rules.ts` refuses a relay scheme
with a sentence). With the keyring alone nothing observable changed. The gateway is routed to
first: an operator's explicit host list wins over a broker's catalogue (`environmentProviders` in
`apps/server/src/backings.ts`). **A hosted provider comes from the private package whole** — its
client, its relay plugin, its provider, its variables and its fakes (ADR 0002 as amended
2026-09-19; GRA-103) — and the open suites that exercise a link's two ends, the card, the relay rung
and the revoke's release drive `packages/core/src/connection/testing/fake-link-provider.ts`
instead: a `ConnectionProvider` of kind `link` whose coverage is the test's function, whose rows
carry `relay`, whose `start` mints a link on a fake origin, whose `complete` answers the next account
the test connected (`connectAccount`), and whose `resolve` relays to an in-process upstream. The
copy the card and the console draw names a provider by its `name`, never a vendor.

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
`apps/server/src/mcp-oauth.integration.test.ts` over Postgres with the SDK's own client. **A session
this process no longer holds is re-opened for a chat product's client** (GRA-129; ADR 0018 as
amended 2026-09-20): a `grfta_` request with an unknown session id, or with none and no
`initialize`, gets a session under that id (or a new one, on the response), primed by a synthetic
`initialize` with no client capabilities — Claude's card frame keeps its pre-deploy id and drew
"Unable to reach Graft" on the spec's 404; a static-token agent still gets the 404 and 400
(`packages/mcp/src/http.ts`, pinned in `apps/server/src/mcp.test.ts`). **A fresh `initialize`
announcing a protocol version the SDK lacks negotiates instead of being refused** (GRA-162; ADR 0018
as amended 2026-09-22): the door drops the `MCP-Protocol-Version` header on a session-less
`initialize` when the SDK does not speak it, so the body's version negotiates to Graft's latest —
Claude.ai has announced `2026-07-28` on every session since 2026-09-20 — and a request that names a
session keeps the SDK's 400. Under `open`,
authored code runs on the backing `GRAFT_SANDBOX_BACKEND` names:
`docker` by default, which needs the `GRAFT_SANDBOX_IMAGE`/`GRAFT_SANDBOX_NETWORK` pair below and,
unset, leaves the server up with every run refusing for want of a sandbox; or `fake`, a temporary
directory on the server's own disk for a laptop without a daemon — the toolbox then lives in that
directory too, for as long as the process does — which is not a sandbox, and `@graft/env` refuses it
in production and beside `cloud`.

**A chat product's agent lists no authoring tool and no `execute__` tool** (GRA-125; ADR 0004 as
amended 2026-09-20). `packages/mcp/src/by-hand.ts` judges the agent once per session by its
`connected_via_client_id`: a static-token agent (Hermes, OpenClaw) lists the whole set; an agent a
chat product holds over OAuth lists the meta-tools and its promoted tools, and a call to a hidden tool
is refused `advanced_tools_hidden`. `find_tool` answers `connections` — every live connection in the
agent's scope with the `connectionId` `acquire` takes — which is where such an agent learns one.

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
every `execute__<id>` and every authored tool in the list, whose first write answers the tool ask,
and `find_tool`, whose answer may carry the Setup offer's card (GRA-210, the paragraph on it below);
ChatGPT's alias `openai/outputTemplate` rides beside it, and the
resource carries the `openai/widget*` aliases of its `ui` keys (GRA-112); their awaiting results
carry the card's data under `structuredContent.card` beside GRA-55's unchanged `url`, `message` and
`reason` (`result.ts`'s `withCard`). **For a client the server knows renders the card, the awaiting
`message` takes its card form and `cardShown: true` rides beside `url`** (GRA-120; ADR 0006 as
amended 2026-09-20): `packages/mcp/src/card-client.ts`'s `clientRendersCards` is the card gate's
client half — an OAuth agent whose client registered every one of its redirect URIs on a
`GRAFT_CARD_HOSTS` host, which is the whole rule since GRA-150 (ADR 0006 as amended 2026-09-21: a
client writes its own `initialize`, so its declaration of the MCP Apps extension admits nobody and
is only observed, on each tool call's wide event) — held once per session, and its
`toolAskResult` is where every awaiting result goes onto the wire (`tools/meta.ts`,
`tools/execute.ts`, `tools.ts`); each
ask flow writes both forms through `handoff-message.ts`, so the console form a static-token agent
or an unvouched client reads is byte for byte what it was, and `url` never changes.
`SERVER_INSTRUCTIONS` carries the one clause on what `cardShown` means; the Hermes skill does not,
since a Hermes agent never receives it, and `session.test.ts` records that. **An awaiting result
is not an MCP error**: every `awaiting_*`
answer returns through `result.ts`'s `toolAwaiting` with `isError: false` and the same JSON, because
a host renders no view for an error result (ext-apps issue 694) — refusals and failures stay
`isError: true`. The card answers by calling `answer_ask` (`tools/answer-ask.ts`), declared
`_meta.ui.visibility: ["app"]` so the host hides it from the model; the tool refuses a static-token
agent, an OAuth client whose hiding is not established (not every registered redirect URI on a
`GRAFT_CARD_HOSTS` host), another agent's ask, a closed or expired ask, and every ask but the
build approval, the tool's first-use approval
(GRA-116), the keyless connection confirmation, the scope ask and a link provider's decline, and
records the rest through `ask-answer.ts` — the same functions the console's
`POST /pending-actions/:id/answer` and `/connection` call, with `via: "card"` on the answer. The
gate is `tools/card-gate.ts`, shared with the two other app-only tools. The consent page says
which way a client will go before the person connects: `GET /api/mcp-oauth/request` answers
`rendersCards`, read from the same function over the same parsed list
(`apps/server/src/mcp-oauth.ts`), and `components/agent/consent-card.tsx` shows one sentence when
it is true. `packages/mcp/src/answer-ask.test.ts` is the suite;
`pnpm --filter @graft/ask-card build` before `pnpm --filter @graft/mcp test` on a
fresh checkout, or let `pnpm run test` order it.

**Every ask settles in the card; the console is a popup for the secret alone** (GRA-116, GRA-117,
GRA-118; ADR 0006 as amended 2026-09-19). Three more tools and one query. **A provider that cannot
start its link steps aside** (GRA-147; ADR 0019's bullet of 2026-09-21): `mintProviderLink` rewrites
the open ask onto the keyring (`providerConnect: form`, a `note`, `providerFallback`) through
`PendingActionDeps.updatePendingActionPayload`, the console's button answers `{ fallback: "form" }`
and its card re-reads as the form, `start_link` answers `card_not_available` pointing at that form,
and `routeProposal` words a repeated call for the ask as it stands (`asked`), not as it would route.
The two link routes count `provider_link_started`, `provider_link_fell_back` and
`provider_link_returned`. `start_link
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
`graft:ask` to its opener and closes itself 1.5 s after a successful submit (since GRA-144 every
link visit closes itself, the card's alone announces first — `lib/handoff-page.ts`), `/link/callback?from=card`
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

**A keyless proposal for a vendor the person already holds widens that row** (GRA-167; ADR 0006 as
amended 2026-09-22). When `existingConnectionFor` finds no row covering a `none`-scheme proposal
but the person has a live, usable keyring row of the vendor on `none` in this agent's scope, the
verdict is `widen` and `askToWiden` makes a `connection` ask about that row: the row's primary host
and name, `hosts` grown to the union, `widens: { connectionId, addedHosts }` on the payload, the
`connection_id` column set. `confirmConnectionAsk` reads `widens` and calls `@graft/core`'s
`widenKeylessConnectionHosts` instead of registering a row; the agent's next call answers
`connected` ("Confirmed. … now reaches …"). The console's card and the ask card draw the added
hosts and no form. A keyed or revoked row, or one outside the scope, is never widened.

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
connections` first, `Selected connections` revealing the picker — through `components/agent/scope-mode-field.tsx`
in the create dialog and the consent card; the labels and the write's body are
`src/lib/scope-mode.ts`, tested.

**A tool follows its vendor's reconnected connection** (GRA-122; ADR 0007 as amended 2026-09-20).
`authored_tool.default_connection_id` is the row the tool was authored against, and a run resolves
the connection **per agent** (`packages/mcp/src/run.ts`): the default when this agent holds it
live; otherwise — revoked, or a live row another agent of the person's holds and this one was never
given — the **one** live, usable connection of the tool's vendor in this agent's scope. The row is
rebound only when its default is revoked, dead for every agent, through `@graft/core`'s
`rebindToolIfConnectionDead`, which reads the default's row locked (`ToolDeps.findConnectionForUpdate`)
and writes only if it is still dead, so a reconnection landing meanwhile wins; a live default
outside the scope is another agent's and stays. With no such connection the
`connection_revoked` or `connection_not_in_scope` refusal stands as before, and with several it
names them under `alternatives` and says the step is the person's (`revoke.ts`'s
`revokedConnectionRefusal`, `run.ts`'s `notInScopeRefusal`). A caller that names the connection
(`AuthoredRunArgs.connectionId`) is never followed: `acquire`'s dry run passes the job's connection,
so a version published onto an existing tool row is proved against the connection the job authored
it for; a publish onto an existing tool under `activate: false` rebinds the row to
`defaultConnectionId` through the same function, in the publish's transaction, only when the row's
default is missing or revoked — a live default waits for the pass, so a failed job leaves the tool
where it was (`packages/publish`, step 8). The job's "did not run" progress line and `tried[].summary` carry a
refusal's `reason: message` rather than the word `refused`. `packages/mcp/src/server.test.ts` (the
GRA-122 describe), `acquire.test.ts` and `publish.service.test.ts` are the suites.

**A file moves between tools as a blob, never through the model** (GRA-181; ADR 0023). A blob is a
directory `<id>/` holding `data` and a `meta.json` sidecar under the agent's blobs directory,
`.blobs/<agentId>/` beside the toolboxes on the toolbox volume (the Agent Drive in the hosted form),
which the agent's sandbox mounts alone at `/blobs` as it mounts the toolbox at `/tools`; the scope
is that mount, since a vendored dependency runs in-process and the check never reads it. The runner's
`ctx.blob.write` writes into a temporary directory and renames it once, `ctx.blob.read` answers a
`Blob`; the ref `blob://<id>` is a plain string in a tool's result and the next tool's input, and the
runner's ledger comes back beside the result as `blobs` so the server writes one `blob` row per file
through a blob store seam beside the toolbox store. The check bans `fs`, `fs/promises`,
`worker_threads`, `vm`, `module`, `cluster` and `inspector` as defence in depth, the runner refuses a
ref that does not resolve under `/blobs`, and the door refuses `blob_not_found`, `blob_expired` and
`blob_quota` before a sandbox is touched, on every path that invokes the runner for an agent:
`run_tool`, every authored tool in the list, `execute__<connection>` and `run_command` (GRA-200). 24
hours, 256 MiB per blob, 1 GiB live per agent, all constants; writing one never asks. The working-set sweep's timer runs a second pass that removes
expired blobs through the blob store and keeps the row with `removed_at`. The proxy's cap is
`GRAFT_PROXY_MAX_BODY_BYTES` (default 10 MiB; ADR 0010 as amended 2026-09-22), so a self-host moves
a file larger than that only once its operator raises it. The spec is GRA-181 and its sub-issues are
the build order.

**The write path is GRA-186.** `ctx` is five frozen names, `blob` the fifth: `ctx.blob.write(data,
{ contentType, name? })` takes a `Uint8Array`, a `Blob` or a `ReadableStream<Uint8Array>`, streams
it into `/blobs/<id>.tmp/`, writes the sidecar (`bytes`, `contentType`, `name`, `writtenAt`,
`expiresAt`, `agentId`, `toolVersion`) and renames the directory once; `stat` reads the sidecar;
`read` answers a lazy `Blob` (the paragraph on GRA-187 below). The runner's stdout contract is now
an **envelope**, `{ result, blobs }`, on the sync, detached and dry-run paths alike
(`readRunnerEnvelope` in `@graft/runner`). Since GRA-193 each server seeds the runner and the skills
under `/graft/<sha256 of both>/` when that directory is absent and runs from it, handing every
command the path as `GRAFT_RUNNER`, so every sync run goes through this server's runner and
`run.ts`'s `unwrapEnvelope` refuses stdout with no envelope as a module that printed to stdout
itself (GRA-199); the one bare result still read is a detached run's result file written by a
runner older than the envelope and polled after an upgrade, in `sandbox.ts`'s `readRunnerResult`.
Three per-exec variables ride beside the token and are deleted with it before the module loads:
`GRAFT_AGENT` and `GRAFT_TOOL_VERSION` for the sidecar, never for a path (`GRAFT_AGENT` is
`blob-door.ts`'s `blobAgentEnvironment`, on every capability run and inside `blobRunEnvironment`,
since an `execute__` command may invoke `$GRAFT_RUNNER` on a by-hand module), and `GRAFT_BLOBS_DIR`, the
mount path, a variable for the reason `GRAFT_RESULT_PATH` is one (a backing that maps the sandbox's
paths maps the environment's values; the fake does). On the wire a run that wrote nothing answers
exactly what it did; one that wrote answers `{ result, blobs: [{ ref, bytes, contentType, name?,
expiresAt }] }` in the text block and `structuredContent`, the list cut at `MAX_RESULT_BLOBS` (32)
with a count and a note; `wait_for_process` puts the same list beside a detached run's `result`. The
`blob` table (`packages/db/src/schema/blob.ts`, migration 0011) is keyed by the id inside the ref and
carries the person and the agent, so `repo/blob.ts` names both in every statement; `@graft/core`'s
`recordBlobsWritten` writes the rows from the ledger, `packages/mcp/src/blobs.ts` calls it from the
sync run (with the version) and the poll (without one, since a poll cannot know it) and fires
`McpDeps.onBlobWritten`, which the server captures as `blob_written` with the size and the media type
and never the name.

**The read path and the door are GRA-187.** `ctx.blob.read(ref)` answers `fs.openAsBlob` over
`/blobs/<id>/data`, typed from the sidecar, so `.stream()` reads the file in 64 KiB chunks and a
`FormData` upload never holds it whole; a ref that does not resolve there is `blob_not_found` with
the ref in the sentence, whether it is not of the scheme, fails the id rule, names a `.tmp`, names
nothing, or reaches a symlink at the directory or either file (`lstat`, as the store judges the
tree from outside). The runner checks no expiry: **the door is the expiry's one judge.**
`packages/mcp/src/blob-door.ts`'s `admitBlobs` runs in `run.ts` after the input is validated and
before the approval gate, for a dry run too, so `acquire`'s job learns of a dead ref there: the
agent's live bytes (`sumLiveBlobBytes`: `removed_at` null and `expires_at` ahead, one statement)
against `BLOB_QUOTA_BYTES` answers `blob_quota` with `bytes` and `quota` on every run, a ref in the
input or not; then every `blob://` string leaf of the input, arrays and nested objects included, is
looked up under the person and the agent in one statement (`findBlobs`) and the first without a row
is `blob_not_found` with `ref`, another agent's row answering the same sentence, and the first past
its expiry (`@graft/core`'s `isBlobExpired`, `expiresAt <= now`, the sweep's and `sumLiveBlobBytes`'s
rule too, GRA-199) or with `removed_at` set is `blob_expired` with `ref`, naming `BLOB_TTL_HOURS`.
Each is a refusal in the run's own shape (`isError: true`, a `refused` ledger row) and none asks (ADR 0008).
The quota lives beside the scheme, the cap and the TTL in `@graft/runner`'s `runner-source.ts`,
the one file that spells the three numbers; `judgeBlobQuota` and `judgeBlobRefs` are pure and
`blob-door.test.ts` pins the sentences, `server.test.ts` the loop end to end over the fake sandbox.
**A run the door admits is handed its budget** (Greptile on #145): the door's check runs once,
before the run, so `run.ts` puts `BLOB_QUOTA_BYTES - liveBytes` into the exec as
`GRAFT_BLOB_BUDGET_BYTES` (the quota beside it as `GRAFT_BLOB_QUOTA_BYTES`, for the sentence), both
deleted with the rest before the module loads, and the runner keeps the total it has committed and
refuses the write that would pass the budget as `blob_quota` as the bytes stream in, at the smaller
of the per-blob cap and the budget, removing the `.tmp` directory as `blob_too_large` does; a
refused write is on no ledger. Unset, as under a server older than the variable or a runner run by
hand, the per-blob cap alone bounds a write. **`execute__` commands and `run_command` pass the same
door** (GRA-200): `tools/execute.ts` and `tools/authoring.ts` call `admitBlobs` before the exec (the
quota alone, since a shell command is not JSON the runner reads), refuse `blob_quota` in their own
shape with no exec, put the two variables into the process's environment beside the runner's path,
and hold the grant on the in-flight registry until the process settles, a detached one's on its
process name through `heldInFlight`'s `budgetBytes`; `isPolledProcess` in `sandbox.ts` is the one
spelling of the runner-answer shape the three readers of a ledger share. Two rules from Greptile's
review of #157: **the admission and its grant are one step** (`admitUnderGrant` in `in-flight.ts`,
serialised per agent through `InFlightRegistry.admit`, on `run.ts`'s path too), since two
admissions interleaved across the door's await both read the remainder before either reserved it;
and **the record of a run's blobs is an adoption from the store** (`blob-budget.ts`): a by-hand
command can hand the runner any `GRAFT_BLOB_BUDGET_BYTES` it likes, print any ledger and edit any
sidecar, so when the server records a run's ledger (`recordBlobsWithinQuota`, at the three record
sites and at `wait_for_process`) it takes nothing from the ledger but the ids and builds each row as
the sweep builds an orphan's (`adoptedBlobOf`, `parseBlobSidecar`): `bytes` as the store measured,
name and media type from the sidecar under the write rules, `expiresAt` never past the write plus
the TTL with the store's last write capped at now, the version the caller's; an entry the store
cannot `stat`, whose sidecar fails the rules or names another agent, is dropped; an entry naming a
blob with a row already is listed from its row alone while the row is live and the directory is
there (never removed or re-recorded; a second poll of a finished process names the same blob) and
dropped otherwise. The quota is then judged over the live rows plus this run's measured bytes; past
it the newest are removed through the `BlobStore` until the rest fit, get no row, and the run is
answered a `blob_quota` failure naming the overshoot (`blobQuotaOvershoot`, `withRecordedBlobs`
putting the recorded list in place of the declared one). The whole record is one step per agent
under `InFlightRegistry.exclusive`, the critical section admissions take, so two runs finishing
together cannot both find room. The record reads nothing off the grant, which expires with a
detached hold while the result stays pollable; the quota is the promise. The newest go because the
earlier writes are what an honest runner would have committed. Three more rules from Greptile's review of #148: the runner reserves
against the budget **as each chunk lands**, one shared figure across every write in flight, so two
writes started together cannot both fit a remainder only one fits; the door subtracts **what it has
already handed to this agent's runs still in flight** (`InFlightRegistry.grant` and
`outstandingBudget`, `in-flight.ts`; a detached run's grant rides on its process name until its
poll settles it), a per-process record as the in-flight hold is, with ADR 0023's option C as the
shape for the day two replicas admit one agent's runs; and **a failed run reports the blobs it
committed**: a module that writes and then throws prints the same `ENVELOPE_MARKER` line a result's
envelope sits behind (`__GRAFT_ENVELOPE__:1`, `@graft/runner`) and `{ result: null, blobs }` on
stdout before the error (the result file on the detached path), so `readRunnerEnvelope` is the one
reader; `run.ts` records the rows off it and the failure names the refs, while a timeout prints
nothing and its blobs are the sweep's to adopt (GRA-189).

**The sweep's blob pass is GRA-189** (ADR 0023, "the sweep deletes"). On the working-set timer,
after the working-set pass for an agent and under the same in-flight skip, `packages/mcp/src/sweep.ts`
reads the agent's unremoved rows (`listUnremovedBlobs`) and what `McpDeps.blobStore` lists, reads the
sidecar and the age (`BlobStore.stat`, new here: the newest modification time among the directory,
`data` and `meta.json`, and `data`'s size) of every directory no row claims, and applies what
`packages/core/src/blob/blob-sweep.decision.ts` decides, a pure function in the working-set
decision's shape with seven outcomes: `keep` (a live row, with or without its directory, since a
write may still be landing; a `.tmp` inside the bound), `remove` (a row past its expiry whose
directory is there: the directory goes through the store, then `markBlobRemoved` sets `removed_at`,
in that order so a throw between the two leaves a `mark` and never a marked row with bytes on disk),
`mark` (a row past its expiry whose directory is gone), `adopt` (a directory with a readable sidecar
and no row: `adoptedBlobOf` builds the row from what the store measured and the sidecar clamped to
it, since a sidecar is sandbox-written and untrusted: `bytes` is `data`'s real size, `writtenAt` the
sidecar's unless missing or later than the store's last write, `expiresAt` never past `writtenAt`
plus the TTL, `name` and `contentType` held to `BLOB_NAME_RULES` and `BLOB_CONTENT_TYPE_RULES`;
`adoptBlob` writes it, `insertAdoptedBlob` doing nothing on a conflict, which the applier reads as
"a row exists now" and keeps the blob; the next pass judges it as a row), `remove_orphan` (a
directory with no row and no sidecar the sweep can adopt from: absent, unparseable, breaking a write
rule or naming another agent; junk, since the rename is the commit and the sidecar precedes it), and
`remove_tmp` (a `<blobId>.tmp` last written to longer ago than `ABANDONED_BLOB_WRITE_SECONDS` in
`bounds.ts`, the detached ceiling plus the sync ceiling; `RunSweepOptions.abandonedWriteMs` is the
test seam). Expiry is `isBlobExpired`'s `<=` (GRA-199). Only `BlobStore.readMeta`'s `null`, the store's own not-found signal,
reads as "no sidecar"; any other read error ends the agent's pass with the error on the report and
the blob is judged again next tick. A run that starts after an agent's pass began is caught before
every destructive action: the rest of that pass is deferred (`SweepBlobCounts.deferred`,
`SweepReport.deferred`) and finished next tick. The counts ride on
`SweepReport.blobs` and the server puts them on the sweep's wide event under `sweep.blobs`;
`McpDeps.onBlobSwept` fires once per `remove` and `remove_orphan` and the server captures it as
`blob_swept` with `bytes` and `cause`, never the name; a cleared `.tmp` was never a blob and fires
nothing. `sweep -- --plan` prints the blob actions under `blobs.actions` beside the demotions.

**The blob pass's roster is its own, not the working-set sweep's** (GRA-195). The working-set pass
walks the live agents (`listActiveAgentScopes`); the blob pass walks the union of every agent with
at least one unremoved `blob` row (`listAgentsWithUnremovedBlobs` in `packages/db/src/repo/blob.ts`,
the person off the rows) and every agent the blob store lists a directory for
(`BlobStore.listAgents()`, new here: the agent ids under `.blobs/`, sorted, a symlink or a name that
is not an agent id skipped), with the person of a directory-only agent read off the agent table
(`listAgentPersonIds` in `repo/agent.ts`, revoked agents included); `@graft/core`'s
`listBlobSweepAgents` is the union, and both reads are deliberately unscoped and pinned by name in
`repo/scope.test.ts` beside `listAllActiveAgents`, since the sweep has no person to scope by. So a
revoked agent's blobs expire, are removed and are marked on the same 24 hour rule as any other's
and its bytes stop counting; the in-flight skip is a no-op for it, since it can have no run. An
agent the database no longer holds (deleted by hand, its blob rows cascaded away) is walked with no
person: the decision is asked with `agentExists: false`, nothing is adopted, a committed directory
is junk once its last write is past the TTL (`remove_orphan`) and `keep` (reason `unclaimed`) until
then, a `.tmp` goes by the bound, and no `blob_swept` fires, since there is no person to name.
`SweepBlobCounts.agents` counts the agents the pass walked, on the wide event under `sweep.blobs`;
`sweep -- --plan` shows a revoked agent's actions like any other's. A hosted blob store (GRA-192)
implements `listAgents` beside the five verbs or `assertCloudBackings` refuses it at boot.

**`acquire` authors both halves, and the playbook carries the one rule (GRA-190).** The authoring
skill's *Moving a file between tools* section says when to write a blob and when to return data, how
to pipe a response into `ctx.blob.write` (`res.body`, the type and name off the headers, base64 in
JSON decoded with `Buffer.from(data, "base64url")` first), how to read one into a `FormData`, where
the ref goes in the result and that a consuming input takes it as a plain string, and the four
refusal names; `skills.test.ts` pins its sentences to the runner's constants. **A consuming tool's
dry run has a blob to read**: `job.ts`'s `dryRunInput` judges the test input's refs with the door's
own functions before the dry run and, for a dead one, or for none where the module reads
`ctx.blob.read(input.<field>)` (the check's `contextMembersUsed` and `blobReadFields`, bound by the
checker to the default export's two parameters, one level of destructuring followed, so a name in a
comment, a helper's own `.blob.read`, a helper file or a shadowing nested function records
nothing), mints a
**fixture blob** through the runner under a budget grant held and released as a run's is
(`admitUnderGrant` in `in-flight.ts`, GRA-200, and `blobRunEnvironment` in `blob-door.ts`, GRA-199;
`FIXTURE_MODULE` beside the probe:
a few hundred bytes of `text/plain` named `fixture.txt`, the agent's, the normal TTL, a row with no
version) and substitutes its ref in the dry run's input alone, saying so in an `Attempt N:` line;
the draft's `testInput` is never written, and fixtures are never reused across jobs. The door's
`walkStringLeaves` walks an input with a stack, never the call stack, and is the one walker:
`blobRefsIn` reads refs off it, `job.ts`'s `substituteBlobRefs` replaces through it and
`@graft/evals`'s scorers read a result through it (GRA-199); one nested past `MAX_INPUT_DEPTH` (64)
is refused `input_invalid` naming the bound. The rule on
the wire is `session.ts`'s `BLOB_RULE`, in `run_tool`'s paragraph and word for word in the Hermes
skill: a file moves between tools as a `blob://` ref, never as content, and the producing tool runs
before the consuming one is acquired. The budget was measured first (2,045 of 2,048) and the clause
paid for by tightening facts the descriptions carry; `SERVER_INSTRUCTIONS`'s comment lists them. The
facts are the descriptions': `blobs.ts`'s `BLOB_RESULT_FACT` (the list's five fields, the three
refusals) on `run_tool` and appended to every authored tool's definition in `tools.ts`, and
`meta.ts`'s `ACQUIRE_BLOB_FACT` on `acquire`, whose `hints` may carry the ref.

**`ctx.fetch` takes an absolute URL on one of the connection's hosts** (GRA-197; ADR 0010 as
amended 2026-09-23). The runner (`packages/runner/src/runner.mjs`, `hostRoute`) rewrites an absolute
`https://` URL onto the proxy's host form for its host, `${proxy}/c/<conn>/h/<host><path><query>`,
the same route `ctx.proxyBase(host)` names, so the proxy judges the host against the connection's
`hosts` as it does an SDK's call and refuses one the person did not confirm with its existing
`403 host_not_in_set`; the runner holds no host list and adds no variable. Refused in the runner
before any request leaves, each with a sentence: a URL that is not `https:`, one carrying
credentials (`user:pass@`, the host named and the credentials not), one whose host fails
`HOST_PATTERN`. A relative path resolves as before, `redirect: "manual"` stays, and a dry run
records such a call as the parsed URL's scheme, host and path only, the query dropped and marked
`?…` and the fragment dropped (`recordableTarget`), since a vendor-issued URL may carry a signature
or a capability in either and the report reaches the authoring model's prompt. The check's `fetch-absolute-url`
still refuses a *literal* absolute URL at a `.fetch(` call and its sentence says a URL a vendor
hands back at run time may be passed as it is; `global-fetch` and `sdk-not-bound` are unchanged.
The authoring skill's `ctx.fetch` bullet says so, and says to prefer `ctx.fetch` over a vendor SDK
for a write flow, since an SDK that retries on a body it does not expect times out against the dry
run's 202 preview (GRA-198 decides whether the preview changes shape instead). `SERVER_INSTRUCTIONS`
and the Hermes skill carry no sentence on it: the budget stood at 2,039 of 2,048, and the rule is
for the model that writes the module, which is Graft's. This is what let Slack's
`files.getUploadURLExternal` flow (a `POST` of the bytes to `files.slack.com`) be authored without
an SDK.

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
for `linux/amd64` and `linux/arm64`: one build leg per image and platform, amd64 on `ubuntu-latest`
and arm64 on GitHub's native `ubuntu-24.04-arm`, each pushing by digest, and a merge job per image
writing the tags over one manifest list (GRA-180). Nothing emulates an architecture; the QEMU
cross-build this replaced cost the first tag over two and a half hours on the server image. A
`workflow_dispatch` with an optional `ref` is how the file is exercised without cutting a release.
The conformance suite against a running compose project is
`packages/sandbox-docker/src/compose.test.ts`, opt-in by `GRAFT_COMPOSE_NETWORK` and
`GRAFT_SANDBOX_IMAGE`; its header has the command.

The working-set sweep (ADR 0009) runs inside the server on a plain timer, every
`GRAFT_SWEEP_INTERVAL_SECONDS` (default 300): per agent it demotes what went unused past the idle
window, then the least recently used beyond the cap — never a tool used inside the window, and never
while the agent has a run in flight — and fires `tools/list_changed`. Each demotion is a
`working_set_change` row with cause `idle` or `cap`, which `GET /api/agents/:id/working-set/changes`
reads for the console. The rule itself is `packages/core/src/working-set/sweep.decision.ts`, a pure
function; `packages/mcp/src/sweep.ts` applies it, and on the same tick runs the blob pass over its
own roster, revoked agents included (the paragraphs *The sweep's blob pass is GRA-189* and *The blob
pass's roster is its own* above). `pnpm --filter @graft/server sweep -- --plan`
prints what a sweep would do without doing it; without `--plan` it demotes and removes, from a
process that can neither see a running server's in-flight runs nor notify its sessions, so use that
form with the server stopped.

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

**Agent actions** (GRA-132, GRA-135): the agents table's dropdown opens the name/cap/idle-window
edit dialog. The table groups Active and Revoked rows, omitting empty sections. An empty agents
table keeps its headers and a centered, muted full-width sentence, following Cando's connections
table. Archiving is excluded from this branch; the detail page retains standalone revocation
(ADR 0007, ADR 0018).

**Agent harnesses** (GRA-135, GRA-168): the Harnesses column names `connectedVia.clientName`,
recorded at OAuth consent (ADR 0018). A static-token agent records no harness, so its cell is the
prompt **Set up harness** while it is active and *Not recorded* once revoked — a prompt, never a
claim about whether the harness is connected, since a Hermes that is running tools looks the same
as one never configured. The prompt, the row's actions menu and the agent page's header button all
open **Connect a harness** (`agent-connection-dialog.tsx`), named for what the person does: the
word *connection* is a vendor account (CONTEXT.md) and the screen beside this one, and the dialog
never says it. The dialog shares creation's setup (`harness-setup.tsx`: the URL, a harness
picker, the token's place and the configuration in that harness's shape — GRA-152) but cannot
retrieve the token; the token line carries a saved-token placeholder (ADR 0007). OAuth agents get
the URL and consent instructions. An agent *awaiting its harness* (Setup's, no token and no client)
gets both: the URL, whose consent page chooses it, and *Issue a token*
(`POST /api/agents/:id/token`, GRA-208), which shows the token once as creation does. Agent names are links to the standalone `/agents/:agentId` page,
and every row's menu has View agent, revoked rows included; the detail drawer is deferred. That
page keeps scope and limit editors, the working set, approvals, history and standalone revocation;
revoked records are read-only. `GET /api/agents` includes `workingSetCount`, counted against each
person-scoped agent in the same statement; the table shows count/cap with Cando's status dot.

**Setup is one record per person and three routes** (GRA-204; ADR 0024). The `setup` table
(`packages/db/src/schema/setup.ts`, migration 0012) keys on the person: the step reached, the
harness, the agent, the open connection ask, the connection, the acquire job, the tool, and
`started_at`, `completed_at`, `skipped_at`; `repo/setup.ts` names the person in every statement,
pinned in `repo/setup.test.ts`, and `lockSetup` makes the row and locks it so two starts, or a start and a skip, serialise.
`@graft/core/setup/` holds the service (`getSetupState`, `startSetup`, `skipSetup`), the
browser-safe rules (`shouldShowSetup` over the record and the person's connection and tool counts,
`isAwaitingHarness` over an agent, `currentSetupStep`) and the harness data (`SETUP_HARNESSES`:
the seven in the marketing site's order, each with its kind, `oauth` or `token`, the site's label
and the finish step's connection `steps`; since GRA-208 it is also `setup-prompt.ts`'s list,
`SETUP_PROMPT_HARNESSES`, which `GET /api/setup-prompt` answers as `{ id, label, description }`). `GET
/api/setup` answers `SetupState` (the record, `step`, `show`, the agent it runs as, the active
agents); `POST /api/setup/start` (`SetupStartBody`) mints an agent with no token and no client
through `createAgentAwaitingHarness` when the person has none, adopts the one when there is one,
and needs `agentId` among several; `POST /api/setup/skip` sets `skipped_at`. Both are rows in
`analytics-routes.ts` carrying `harness`, read off the answer by the row's `properties`. The console:
`routes/_auth/setup.tsx` is under the guard and outside the shell; `_shell/route.tsx`'s `beforeLoad`
redirects to it on `show`, except `/consent` and `/pending` (`lib/setup-intercept.ts`); one
component per step under `components/setup/`, wired in `setup-step.tsx`'s map, each moving the
record through `useSetupMutation`, which writes the answered state into the one `["setup"]` entry.
The agents table draws *Awaiting harness* (`AGENT_STATUS_CHIP.awaiting_harness`, outline) and
offers *Set up Graft* in its empty body to a person who skipped.

**The vendor and connect steps are the agent's own connection ask** (GRA-206). The starters are
`@graft/core/setup/starter-vendors.ts`, browser-safe, one entry each (vendor slug, hosts, docs, the
keyring's scheme and parameters, the curated read-only `goal`, `runInput` with its default, the
`outcome` sentence); adding one is one entry. `setupVendorOptions` is the pure filter and order over
each starter's covering provider: a keyring form over `oauth_authorization_code` is dropped, and
`link` leads, then `none`, then `keyless` (a `none` scheme the form provider lists), then `form`.
`GET /api/setup/vendors`
asks `providerFor` per starter in `Backings.providers` order (`apps/server/src/setup-connect.ts`);
the console never computes coverage. `POST /api/setup/connect` (`SetupConnectBody`: `{ starterId }`
or `{ connectionId }`) calls GRA-203's `routeConnectionProposal` as the setup's agent, through
`ApiOptions.connectionRouting` (the server binds its `McpDeps`), and moves the record through
`moveSetupConnect`: an ask to `connect` with `pendingActionId` (a repeat re-uses it by proposal
key), a connection made or found at once, or *Another vendor*'s ordinary-form connection (added to
the agent's scope), to `goal`. `GET /api/setup` reads the ask the record waits on and never takes
a live answer: answered with a connection (or a `scope` ask allowed) that is still live, usable and
in the agent's scope it moves to `goal` naming it; declined, expired, gone, or answered with a
connection revoked or taken out of the scope since (that answer is taken, so the routing stops
handing it back, under the record's lock so two reads take it once), back to `vendor`, and on
`goal` a connection that stopped standing takes it back too, judged again under the lock
(`moveSetupConnect`'s `confirm`) so a restore meanwhile stands. The connect route that finds such
an answer (or finds a poll reopened the record for it) routes once more, and that second routing's
move lands only on the record as it was seen on `vendor`, its `updatedAt` unchanged
(`fromVendorAt`; `saveSetup` moves it forward by at least a millisecond on every write), so the choice in flight wins over a poll and any choice another tab made since
stands, even one that closed and left the record on `vendor` again. A stale answer is judged again
under the lock before it is taken, so one made good meanwhile is left for the next read. `setup_step_completed` carries `step`: `vendor` from the connect route's row, `connect`
captured by the request whose move changed the record (`SetupMoveResult.moved`), so two reads of
one answer count once. A listed agent's scope grown by Setup (*Another vendor*, a `scope` ask
answered in the console) is announced to its session, since no waiting call of its own does. The
console's connect step draws the open ask from the inbox's list with `PendingActionCard` under
`origin="setup"` (no model provenance, the proposal editor folded behind *Edit the connection*;
the inbox and the handoff page pass nothing and draw the cards as before), and polls both reads
every 3 s so an answer given in the inbox or a chat card moves it too. The goal step's starter is
`starterVendorFor(connection.vendor)`.

**Build is the build approval, and the building step reads the job** (GRA-207; ADR 0024,
`apps/server/src/setup-build.ts`). `GET /api/setup/goal` answers `SetupGoalContext`: the record's
connection, `starterId`, the curated `goal` (empty for another vendor) and `build`, which is
`{ available: false, reason: "acquire_unconfigured", message }` whenever `@graft/mcp`'s
`acquireConfigured` (the `acquire` door's own model check) says no; the console then shows the
message naming the variables and disables Build. `POST /api/setup/build` (`SetupBuildBody`:
`{ goal }`) is `@graft/core`'s `startSetupBuild`, one transaction under `lockSetup`: from `goal`
only, the connection not revoked (refused `connection_revoked`; a revoked row stays in a resolved
scope) and still in the agent's scope, `grantBuildApproval` for the pair (the standing
row answered when the connection card already granted it), `createAcquireJob` with Setup's own
first line and `setupBuildHints` as `hints` (the starter's documentation, after the starter's own
`hints` when the goal is its curated one unchanged; GRA-209), the record to `building` naming the job;
the route then kicks the runner. No pending action is opened, and `similar_tools_exist` is not
asked. `ApiOptions.acquire` is the model, the job's deps and the runner (the server binds its
`McpDeps`). `GET /api/agents/:id/acquire-jobs/:jobId` answers `acquire_status`'s shape
(`acquireStatusOf`) for one of the person's agents, never held; another person's agent or job is a
404. `GET /api/setup` learns a succeeded job's tool through `moveSetupBuild`'s `built`: `building`
to `result` with `toolId`, or the tool noted on `finish`, or on `completed` when Finish Setup
came first. A failed job leaves the record on `building`; `POST /api/setup/goal` (*Change the
goal*) goes back to `goal` with the job cleared,
refused while the job may still pass, and `POST /api/setup/continue` (*Continue while it runs*)
goes to `finish` with the job kept. `setup_step_completed` adds `goal` (the build route's row) and
`building` (captured by the read whose move named the tool, `SetupMoveResult.moved`). The console's building step polls the job route
every 2 s and draws each line beside its stage's sentence on the stage's first line
(`lib/setup-progress.ts`'s `progressStage` and `explainProgress`, keyed on `acquire/job.ts`'s
lines; a new progress line there wants a rule and a case in `setup-progress.test.ts`).

**The goal step's chips come from the triage model, and the curated goal is in the person's
voice** (GRA-209). A starter's `goal` is what the person reads as their own, short and in the
first person; the detail the model needs (the input's field, the endpoints, *Read only*) is the
starter's `hints`, which reaches the job only beside the curated goal unchanged. `ModelAdapter`
carries an optional `proposeGoals` (`@graft/model`'s `propose-goals.ts`, shaped as `triage.ts`'s
calls: the triage model, a strict output, one attempt, traced with `situation: "propose_goals"`
and the request's `traceId`, `setup:<personId>`, where a job's id would be; bounded at
`GOAL_PROPOSAL_TIMEOUT_MS`, 8 s, and never throwing). The provider's adapter implements it, the
scripted one answers `scriptedGoals(displayName)`, and the router sends it where the person's jobs
go, so a person's own key carries their vendor's name to their provider alone. `GET
/api/setup/goal/suggestions` answers `SetupGoalSuggestions`, `{ suggestions }`, up to three or
none: none and no call where Build is unavailable, the record is not on an open goal step
(skipped, completed or elsewhere) or its connection is gone or revoked, none where the proposal
declined, timed out, failed or answered nothing usable; the outcome rides on the wide event under
`goalSuggestions`, never the goals. The route is a read, outside the `api` rate-limit bucket, so
the model is asked **once per person and connection** inside an hour, whatever it answered, and
the answer held in flight and after (`createGoalSuggestionMemo` in `setup-build.ts`, one per
process; `cached: true` on the wide event). It is its own route so the goal step draws at
once; `components/setup/goal-suggestions.tsx` asks it after, keyed by the connection outside
`["setup"]`, and draws outline `Button` chips that fill the field, or nothing.

**The result step runs the tool, and the finish step connects the harness** (GRA-208; ADR 0024,
`apps/server/src/setup-finish.ts` and `tool-run.ts`). `GET /api/setup/tool` answers
`SetupToolContext`: the record's agent and harness, the connection, the job's goal and status (with
the failure's sentence), the tool once it landed (wire name, input schema, `readOnly`) and the
starter's `runInput`. `POST /api/agents/:id/tools/:vendor/:name/run` (`ToolRunBody`: `{ input? }`)
is the console's second caller of a run: `@graft/mcp`'s `runAuthoredTool` with the server's
`McpDeps` (`ApiOptions.run`), synchronous at `DEFAULT_COMMAND_TIMEOUT_SECONDS`, `NO_ELICITATION`,
never a dry run, answering `AgentToolRunOutput` (`{ ok: true, result }` or `{ ok: false, reason,
message, answer }`, the run's own refusal or failure); a tool whose annotation is not read-only is
`409 tool_not_read_only` and one outside the agent's working set `409 tool_not_in_working_set`,
both before the run and again on the run's own read of the tool inside the agent's in-flight hold
(`AuthoredRunArgs.admit`), so a republish or a demotion in between cannot reach the gate or the
sandbox and no ask is ever opened from the console; another person's agent is a 404.
`POST /api/setup/result` is `moveSetupBuild`'s `finish` (`result` to `finish`), and
`POST /api/setup/finish` is `@graft/core`'s `finishSetup`: from `finish` only, one transaction
under `lockSetup`, the record to `completed` and, for a `token` harness whose agent is still
awaiting it, the token issued through `issueAwaitingAgentToken` and answered once beside the state
(`SetupFinishOutput`); a second finish is `409 setup_completed`. `POST /api/agents/:id/token` is the
same issue for *Connect a harness*; the write (`issueAgentToken` in `repo/agent.ts`) holds the
awaiting rule in its statement, so two issues mint one token. `setup_step_completed` adds `result`,
and `setup_completed` carries the harness. The console: `result-step.tsx` runs the tool once on
arrival with the starter's default (`lib/setup-run-input.ts`), editable, and shows the answer in
`CodeBlock`; `finish-step.tsx` draws, by `lib/setup-finish.ts`'s `finishVariant`, the token once
with the configuration blocks, the URL and the harness's steps ending on the consent page, or
(a record that adopted an agent, `harness` null) the first request to ask in the chat, with
`SetupPromptBlock` personalised with the agent, the connection and the tool (arriving while the
job runs, the state read every 3 s). The finish's answer, token included, is held in
`routes/_auth/setup.tsx`'s state, never the query cache, so the step keeps showing it once the
record reads `completed`. The consent card pre-selects the person's one agent awaiting its harness
and falls back to *A new agent* with none or several (`lib/consent-default.ts`).

**`find_tool` offers Setup in the chat, as a card where the client renders one** (GRA-210; GRA-202,
*The in-chat door*; ADR 0024). For an agent whose person has no connection at all (revoked rows
count, as the show rule counts them) and whose Setup is neither completed nor skipped
(`@graft/core`'s `shouldOfferSetup`), `find_tool` answers `setup: { url, message }` beside `tools`
and `connections`: `url` is `setupUrl(GRAFT_CONSOLE_URL, agentId)`, `/setup?agent=<id>`, and
`message` is `handoff-message.ts`'s `setupOfferMessage` in the console form (GRA-55's relay
clause). The record is read (`getSetupRecord`, `McpDeps.setup`) only when the person's connection
count, which `find_tool` already holds, is zero; `packages/mcp/src/setup-offer.ts` is the rule's
home. It is **not an ask**: no pending action, no signature, no expiry, `isError` unset, and
`answer_ask` has nothing to admit. For a `clientRendersCards` session the message takes its card
form, `cardShown: true` rides inside `setup` beside `url`, and `structuredContent.card` is a
`SetupCard` (`@graft/ask-card/shape`: `{ kind: "setup", agentName, url }`, beside `AskCard` in
`CardData`; `readCardData` reads either). The card (`render.ts`'s `renderSetup`, dispatched by
`renderCard`) draws a title, a sentence, the agent, a sentence saying to ask again once done, and
one button, *Set up your first tool*, that opens the URL with `from=card` through `ui/open-link`;
it polls nothing. Where the host refuses the window, the card shows the bare URL to copy
(`setupOpenRefusedOf`), since the card-form message tells the model not to send a link and to
give that URL only when the person says they cannot see the card or it could not open Setup.
**One card per session** (GRA-212): the card, the card-form message and
`cardShown` ride on the first `find_tool` answer of an MCP session that carries the offer, held
per session in `setup-offer.ts` as `clientRendersCards` holds its verdict; every later answer in
that session carries `setup` in the console form and no card, since a host mounts the card for
every result of a tool that names it and ChatGPT called `find_tool` five times in one turn. A
session the server re-opens (GRA-129) is a new one. `find_tool`'s description gained one
capability sentence and `SERVER_INSTRUCTIONS` is unchanged. The wide event counts `setupOffered: true` when it was made.
The console's `/setup` validates `?agent=&from=` (`lib/setup-page.ts`'s `readSetupSearch`); the
harness step starts as the named agent when it is one of the person's active agents, even among
several (`agentToAdopt`); a page the card opened shows an `Alert` saying so and, once
`POST /api/setup/finish` succeeds with no token, posts `{ type: "graft:ask", setup: "completed" }`
(`card.rules.ts`'s `setupCompletedMessage`) to its opener and closes itself after
`FROM_CARD_CLOSE_MS` (`afterSetupFinish`); a finish that issued a token stays, since the token is
shown once. `packages/mcp/src/setup-offer.test.ts` is the suite.

**Screens follow Cando's patterns** (GRA-47). Every list is a `DataTable layout="grid"` with the
column widths declared on `TableHead` — a mobile width and an `md:` one, the prose column left
auto — and `DataTableRow` for the 40px rhythm; a column the row cannot afford at 390px steps out
(`hidden md:table-cell`) and, where it is the row's one load-bearing fact, follows the name in muted
text instead. Loading, empty and failed are rows *inside* the body, never a spinner or a block
beside the table: `components/table-body-states.tsx` holds `TableLoadingRows` (one full-span
skeleton per row) and `TableBodyNote` (one full-span sentence), and the failed note carries
`components/retry-notice.tsx`, Cando's inline Retry. A table owns its read (`useQuery`, not the
suspense form) so those states are reachable. The agents table starts its reads without awaiting
and paints its own pending rows. Connections stay cards —
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
primitive without a frame of its own, with a sentence-case title without a full stop and short,
concrete supporting copy — except where the screen *is* a table: there the empty is one muted
full-width sentence inside the body, as Cando's connections table and the agents table (GRA-135)
do, and the headers stay. An in-card empty is one muted sentence. **Console copy has no em dashes.**
Text-input placeholders use sentence case and a clear prompt; examples belong in helper text.
`PageContainer` gaps: `gap-4` under the header of a list screen, `gap-6` on a detail or settings screen
with several regions, as Cando's connections and settings screens pass them.

**Same-origin with the API, in both forms.** `pnpm --filter @graft/web dev` (or `pnpm run dev`, which
starts the server too) serves the app on `:3001` with Vite proxying `/api` and `/mcp` to
`GRAFT_SERVER_URL` (default `http://localhost:3000`), and in production `apps/server` serves
`pnpm --filter @graft/web build`'s output from `GRAFT_CONSOLE_DIR` (default `../web/dist`, relative
to the server's working directory) with an SPA fallback (`apps/server/src/console.ts`). The session
cookie therefore never crosses an origin; `GRAFT_CORS_ORIGIN` remains for a console served from
elsewhere. A server whose console directory holds no build boots and answers every console path with
a JSON 404 saying where it looked. `GRAFT_CONSOLE_URL` is a different setting: where handoff URLs
point (GRA-23), which in development is the Vite origin.

**Nothing but the console calls `/api` with a session, and three rules hold it to that** (GRA-148).
*The session cookie follows the deployment*: `@graft/auth`'s `sessionCookieAttributes` derives it
from `GRAFT_AUTH_URL`, `GRAFT_CONSOLE_URL` and `GRAFT_CORS_ORIGIN`: `sameSite: "lax"` where the
console and the API answer on one origin, `"none"` only where the console is elsewhere, and
`secure` from the scheme, so a self-host on a plain `http` LAN address can sign in at all. A
console elsewhere over plain non-loopback http is refused at boot, because the browser drops that
cookie. *An origin check on `/api`*: `apps/server/src/origin-guard.ts` refuses every non-`GET`
request whose `Origin`, then `Referer`, then `Sec-Fetch-Site: same-origin`, is not the auth
origin or one of `GRAFT_CORS_ORIGIN`, with a 403 in the API's own refusal shape. Four kinds of
route are exempt and the file says why beside each: `/api/proxy/*` (a capability token from a
sandbox, no cookie), `/api/auth/*` (Better Auth runs the same check against its own
`trustedOrigins`), `/api/health`, and reads. Nothing else under `/api` authenticates by bearer
token: the MCP endpoint and the OAuth protocol endpoints are outside the mount. *A JSON body is
declared*: `parseBody` answers 415 unless the content type is `application/json` or a `+json`
suffix, which takes every route that reads a body out of CORS's simple-request set, so the browser
preflights it; the rule is on the body, so a bare `POST` with nothing to declare still reaches the
`emptyIs` path. The console's `src/lib/api.ts` satisfies all three without doing anything special.

**The shell is Cando's, less the agent rail** (GRA-46). `src/components/shell/app-shell.tsx` mounts
the `Sidebar` primitive off canvas at its own 16rem — the `sidebar_state` cookie it writes is read
back by `src/lib/sidebar-state.ts`, ⌘B toggles it, and below `md` it is the drawer, closed on the
router's `onBeforeNavigate` — with `SkipNav` first in the tree and the `<main>` region carrying
`MAIN_CONTENT_ID`. `main-sidebar.tsx` draws the wordmark (`src/components/graft-wordmark.tsx` — the
supplied SVG with outlined lettering, also used by `AuthHeader`, drawn in tokens; GRA-108), the four
destinations from `src/lib/main-sidebar-nav-items.ts` (a pure data
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
it shows is in its query. **The handoff page sits under the guard but outside the shell**
(`routes/_auth/pending.$id.tsx`; GRA-144, ADR 0006 as amended 2026-09-21): the link an agent relays
opens one ask under the mark and closes itself once answered — `lib/handoff-page.ts` decides how,
tested — while `/pending` (the list, in the shell) stays the console's inbox and answers every ask
inline. `routes/_auth/_shell/consent.tsx` is the other consent — an MCP client's
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
by value before that, ADR 0010 amended). A publish refused only as `draft-missing` — nothing at a draft the check just
read — is the toolbox store's miss, not the module's (GRA-123: the hosted store's view of a path
another sandbox wrote can lag), so `job.ts` asks the store once more before the model is shown it.

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
`McpDeps.onToolCall`, which `tools.ts` fires once per call from its one dispatch point; a `/mcp`
request the door or the SDK's transport refuses before any tool runs carries the refusal under
`mcpRefusal` — status, JSON-RPC code, the answer's own sentence, whether a session was named, and the
agent once the token resolved to one — from `McpDeps.onTransportRefusal` (GRA-131: a bare 400 in the
log was a guess; GRA-164 added the agent). **A `ServiceError` the API answers is a refusal, not the
request's error** (GRA-164): `api.onError` clears Hono's `c.error` for it and puts
`refusal: { code, message }` on the event, so a consumed handoff link's 409 is an `info` line with
no stack, and only a throw that is not a `ServiceError` is logged as the event's error; the runner's
and the sweep's lines ride under `acquire` and `sweep`. Product events are captured server-side at
two chokepoints and nowhere in the console: the API's mutation routes
(`apps/server/src/analytics-routes.ts`, one table from method and path to event) for what a person
does there, and the MCP hook and the acquire runner for what happens over MCP (`tool_called`,
`acquire_completed`, `acquire_failed`); both name the person by id. The Setup read,
`GET /api/setup`, is the one other place (ADR 0024; GRA-206): a step the person completes
elsewhere, an ask answered in the inbox or a chat's card or a job that finished, is learned on the
read, so `setup_step_completed` is captured there, once, when the guarded move of the record
succeeds. The vendors behind the hosted
form and their variables are graft-cloud's, in its private package's `observability/` and `env.ts`.
**A sign-up is the one event the account raises itself** (GRA-157): `createAuth`'s
`onPersonSignedUp` fires from Better Auth's own hooks when a person exists *and* is verified — the
verification click for a password account, the creation for a social account its provider vouches
for — and the server captures `person_signed_up` with `method` and, alone among events, a person
property: the email, through `Capture.person`, so the profile the alpha's events land on has a
name someone can act on. `distinctId` stays the id. The hooked-up Slack message is PostHog's own
destination on that event in the hosted project, not code.

**Rate limiting is a seam, and the open form is unlimited by default** (GRA-149; ADR 0002 as
amended 2026-09-19; ADR 0018's "a rate limit at the edge"; `@graft/ratelimit`). `RateLimiter` is
one `check({ bucket, key, now })` answering allowed, or refused with the seconds to wait, over a
fixed bucket per door: `sign_in` (Better Auth's writes under `/api/auth/*`), `oauth_register`
(`POST /mcp/oauth/register`, the unauthenticated write ADR 0018 names), `oauth_token`, `mcp`,
`proxy` and `api`. `UNLIMITED` is the no-op and **the default in both forms**, so a self-host
refuses nobody until its operator says otherwise and the boot line reads `rate limit off`. The
open backing is `createMemoryRateLimiter`, a token bucket per key held in this one process (two
replicas hold two counts), switched on one bucket at a time by `GRAFT_RATE_LIMIT_<BUCKET>` of the
shape `<limit>/<windowSeconds>`; set any and the boot line names them (`rate limit in-process
sign_in 20/60`). `apps/server/src/rate-limit.ts` is the server's half: one Hono middleware
`rateLimit(limiter, bucket, keyOf)` mounted above each door, which answers 429 with `Retry-After`
in that door's own body shape (the API's `{ error, message }`, the proxy's and `/mcp`'s
`{ error, reason, message }`, the OAuth endpoints' `{ error, error_description }`) and puts
`rateLimited: { bucket, key }` on the wide event, the key a digest when it is an address. Keys are
the person for `api` and the connection for `proxy`, where the request names one, and the client's
address for every door that runs before anyone is authenticated, `mcp` included: the socket's peer
unless `GRAFT_TRUSTED_PROXY_HOPS=<n>` says how many hops are in front, because anyone may send
`X-Forwarded-For`. **Never a key taken from a bearer token**, which is why `mcp` is the address
even when one is presented: an unknown `grft_` costs `requireAgent` a database read, which is the
cost the door rations, and a caller inventing a bearer per request would otherwise buy a fresh
allowance each time. A per-agent count would have to sit after `requireAgent`, where it no longer
saves the read. A refusal happens before the handler, so it is never an approval, a tool call or
a vendor call. `Backings.rateLimiter` is the seam beside `logs`, `analytics` and `model telemetry`;
the hosted form's limits and any store behind them are graft-cloud's, in its private package.

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
`testInput`. `acquire { connectionId, goal }` over MCP waits `GRAFT_APPROVAL_WAIT_SECONDS` for the
job and answers `acquire_status`'s shape — settled with `result` when the job finished in time, else
`{ jobId, status, progress, attempts }`; `acquire_status { jobId, after? }` waits up to twenty seconds
for a progress line past `after` (the count already seen) or the end, then answers the progress lines
and, at the end, `result` — the tool's wire name, version and annotations, or `{ failure, message,
lastDiagnostics, tried }` (GRA-125: a chat model that got the same lines back seven times in twelve
seconds abandoned the job and ran its own code through `execute__`).

### The evals

`packages/evals` (ADR 0012: the eval suite is the gate; GRA-31) runs the real loop against fake
vendors behind the real proxy with the provider-backed model and grades what it did with deterministic
scorers: reads before publish, publish before the first write, no vendor host in the model's code, a
dry run before any ask, the first write through the published tool, and the supporting facts. The
`blob` scenario (GRA-191; ADR 0023) runs the loop twice on one world, a producing tool against a
fake that serves a 3 MiB file and a consuming tool against a fake that takes a multipart upload, the
first tool's `blob://` ref handed into the second's goal and input, and adds five scorers over the
chain: no sentinel of the file in any model turn, the ref answered and carried, the consuming dry
run given a blob to read and its write intercepted, the second vendor's sha256 equal to the first's,
both modules on `ctx.blob`. It is an app-like leaf nothing imports, which is what keeps it out of
the server's Docker image (`apps/server/Dockerfile`'s `prod-deps` installs
`--filter "@graft/server..."`); a server dependency on it would pull it in.

```bash
pnpm --filter @graft/evals eval                      # every scenario; needs GRAFT_MODEL_PROVIDER + GRAFT_MODEL_API_KEY
pnpm --filter @graft/evals eval -- --scenario write  # one by name
pnpm --filter @graft/evals eval -- --scenario blob   # the two-vendor blob chain
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
the pattern). The vendored engineering workflow is the **Skills** section above.

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
