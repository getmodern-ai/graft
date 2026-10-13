# Graft

**Graft gives an agent the integration it is missing. The basics of thirteen integrations are
ready-made; anything else is written on demand against the integration's real API, verified before
use, and handed to the agent as an MCP tool.**

Add Graft to Claude, Claude Code, Codex, ChatGPT, Hermes or OpenClaw as one MCP server. When the
agent hits a task no tool covers, it calls `find_tool`, and a ready-made tool for a connected
integration is one call from its list. When nothing fits, it calls `acquire`. Graft's own coding
model reads the integration's documentation, writes the smallest module that makes the call, checks
it, proves it with reads, publishes it, dry-runs it against the live API with every write stopped at
a proxy, and promotes it into that agent's tool list. The credential never enters the module, the
sandbox or the model. When the agent stops using a tool it leaves the list again, and stays in the
toolbox one call from coming back.

Four words are used exactly as [`CONTEXT.md`](CONTEXT.md) defines them. A **harness** is the agent
software you run. A **person** is the account holder. An **integration** is a service Graft can
connect, Gmail or Slack or your own API, and a **connection** is one account of it that you have
given Graft.

## Connect it

**Claude, Claude Code, Codex and ChatGPT need no token.** Give the product your Graft origin plus
`/mcp`: as a custom connector in Claude, with `claude mcp add --transport http` in Claude Code, with
`codex mcp add` in Codex, or as an MCP app under Plugins in ChatGPT with Developer mode on.

```
https://your-graft.example/mcp
```

The product discovers Graft's own authorization server from that endpoint, registers itself, and
sends you to the console to consent. The consent mints the agent the connector will be, or hands
it the agent Setup minted for it, and you choose what it reaches: every connection of yours, the
default for Claude and ChatGPT, or a list. A client Graft does not vouch for starts with nothing
ticked, so pick there before you finish (ADR 0018, ADR 0007). Revoking that agent ends it.

**Hermes, OpenClaw and any other MCP client** carry a per-agent bearer token instead, minted in the
console and shown once. Hermes takes it under `mcp_servers` in `~/.hermes/config.yaml`, OpenClaw
under `mcp.servers` in `~/.openclaw/openclaw.json`, and the console prints each shape on the agent's
page with the token as `${GRAFT_TOKEN}`, so the file holds no secret.

```yaml
mcp_servers:
  graft:
    url: "https://your-graft.example/mcp"
    headers:
      Authorization: "Bearer ${GRAFT_TOKEN}"
```

Either way the agent now lists Graft's meta-tools, `acquire`, `acquire_status`, `find_tool`,
`promote`, `demote`, `run_tool`, `request_connection` and `request_credential`, beside its own, and
every tool promoted for it as `<vendor>__<name>`. Hermes users can install
[`skills/hermes-graft`](skills/hermes-graft), which says when to reach for them; chat products get
the same guidance in the `initialize` handshake and install nothing. A chat product's agent sees the
meta-tools and its promoted tools only; the by-hand authoring tools are listed only for a
static-token agent, for a person who asked it to drive the loop by hand (ADR 0004).

**Setup does all of this on your first sign-in** (ADR 0024). The console's guided first run asks
which harness you run, connects a first integration, takes the task its first tool should do, has
Graft fetch or build that tool and run it in front of you, and ends with the prompt or the
configuration block that connects the harness. It runs as your first agent, so the tool is already
in the working set the harness will find.

## See the loop run, with no key and no Docker

The eval harness drives the real loop against fake integrations behind the real proxy and grades
what it did with deterministic scorers. `--scripted` plays canned model answers, so it reaches no
provider, spends nothing and needs no Docker daemon.

```bash
pnpm install
pnpm --filter @graft/evals eval -- --scripted
```

About fifteen seconds on an M-series laptop, exit code 0, and a scorecard. One scenario of four,
abridged:

```
  PASS  write: create an order in Demo Orders   (1 attempt(s), 1800 tokens, 2s)
        ok   reads_before_publish               1 read(s) before publish
        ok   publish_before_first_write         no write reached the vendor during the job
        ok   dry_run_before_any_ask             dry run passed; 1 ask(s), 0 before it
        ok   write_previewed                    POST /v2/orders
        ok   first_write_through_published_tool POST /v2/orders under claim
                                                tool=demo__create-order, after the person's yes
        ok   credential_never_recorded          no secret in traces, attempts, status or report

  OVERALL  4/4 scenario(s) passed whole
```

The other three are a read tool, a tool built on an official SDK bound to the proxy, and a chain of
two tools that moves a 3 MiB file from one integration to another through a blob, with scorers
proving that no byte of it reached a model turn. Drop `--scripted` and set a provider key to run
them against a real model. [`packages/evals/README.md`](packages/evals/README.md) lists every scorer
and the evidence it reads.

## What an agent gets

Everything in an agent's list is a meta-tool, a stock tool or an authored tool, and the list is the
agent's **working set**: bounded by a cap and an idle window, and shared with nothing.

- **Stock tools are the basics of an integration, authored ahead of time** (ADR 0025; *ready-made*
  in the console). Thirteen integrations ship with them: Apollo, GitHub, Gmail, Google Calendar,
  Google Drive, Google Sheets, HubSpot, Linear, Microsoft Outlook, Notion, Open-Meteo, Slack and
  Stripe, each with its reads and writes, send an email, find a contact, create an issue. Every one
  was written by Graft's own `acquire` loop as a build step, reviewed, and committed under
  [`packages/stock/tools`](packages/stock/tools) with the recording of its proof, which CI replays
  on every pull request with no secret. A stock tool runs over any connection of its integration,
  whichever way it was connected. The first `promote` or `run_tool` copies it into your toolbox as
  an ordinary tool, which follows stock's new versions until your agent remixes it with
  `acquire … from`. At run time there is no second kind of tool: a stock tool runs in the sandbox,
  through the proxy, under the same approval grain, and leaves the working set by the same sweep.
- **Authored tools are what `acquire` writes** for everything stock does not cover: an integration
  nobody built stock for, or the slice of one that stock's basics do not reach. One module, one
  call, versioned in your toolbox, bound to the integration rather than to one connection, so a
  reconnected account is followed without a rebuild.
- **A file moves between tools as a blob, never through the model** (ADR 0023). A tool that
  downloads an attachment writes it with `ctx.blob.write` and answers `blob://<id>`; the next tool
  reads the ref with `ctx.blob.read`. The ref is what travels in results and inputs, so the bytes
  go from tool to tool and not through a model turn; that is the pattern the authoring skill
  teaches and the eval's blob scenario checks, not a filter on what a tool may return. A blob is
  the agent's own, lives 24 hours, and is the one thing the system deletes.

## What an acquisition does

1. **The agent proposes a connection** with `request_connection`, naming the integration and the
   hosts it needs. An account you already hold answers at once. Otherwise you confirm or edit that
   host list in the console and enter the secret there, complete an OAuth consent against a client
   you registered, connect in one click where the deployment has a provider that covers the
   integration, or confirm with no secret at all for a keyless API.
2. **`acquire` starts a job and returns at once**; `acquire_status` reports progress. A stock or
   toolbox tool that already does the job is named instead of built. The model writes one module
   and the static check reads it back: types against the input schema, banned surface, imports
   outside the module, a literal foreign host, an SDK not bound to the proxy.
3. **The module proves itself with reads**, is published into your toolbox as a version and is
   dry-run by id. Only a version that passed becomes the tool's current one; a failed attempt is
   retried with a changed module, under an attempt cap and a token ceiling.
4. **The tool is promoted** into that agent's working set as `<vendor>__<name>`. The first real
   write is the agent's own call, after your one approval.

A scheduled sweep later demotes what went unused past an idle window, and the least recently used
beyond a per-agent cap. Nothing is deleted; a demoted tool is one `find_tool` call from returning.

## How it is safe

- **A sandbox's only egress is the proxy, and the conformance suite proves it.** The `egress` block
  of [`packages/sandbox/src/conformance.ts`](packages/sandbox/src/conformance.ts), which every
  backing must pass, asserts that a request from inside to `1.1.1.1`, `example.com` or
  `registry.npmjs.org` fails, that a detached process is no freer, and that the proxy answers.
- **The credential never enters the module, the sandbox or the model.** A module's only route out
  is `ctx.fetch`, with a path, a declared host, or an absolute URL the integration handed back; the
  runner rewrites every one onto the proxy, which completes it, signs it and judges the host against
  the connection's declared hosts. An SDK is constructed with the capability token as its key and
  `ctx.proxyBase()` as its base, and the check refuses one bound any other way (ADR 0010).
- **A dry run lets reads through and stops every write at the proxy.** A read is a request that
  cannot change the integration's state: a `GET` or `HEAD`, a GraphQL query, or an endpoint in a
  reviewed table (ADR 0008 as amended 2026-10-10). Every other request stops with a 202 and a
  preview of what would have left. The rule is read off a claim on the capability token, so code
  that bypasses the runner's own fetch still cannot write
  ([`packages/proxy/src/dry-run.ts`](packages/proxy/src/dry-run.ts)).
- **The read-only and destructive annotations are derived, not claimed, and the proxy holds them.**
  [`packages/check/src/annotations.ts`](packages/check/src/annotations.ts) reads them off the
  module's calls with the same classifier: read-only when every call is a read, destructive when
  any is a `DELETE` or an endpoint in a reviewed destructive table, and a module the check could
  not read asks every time. A read-only tool's run then carries a `readOnly` claim, and a request
  under it that is not a read is refused before any credential is obtained.
- **Reads never ask; anything else asks once per agent, and the answer holds** (ADR 0008). You can
  set a tool to ask on every call, allow every tool of an integration for an agent at once, with
  destructive tools only if you tick them, and withdraw any of it from the agent's page. An
  approval is for the version it was given for: a republished write asks again once, and a
  ready-made tool's update keeps it unless the update widens what the tool may do.
- **Secrets and approvals happen in the console, never in chat.** A meta-tool returns a handoff URL
  and waits; the person answers on a page of their own (ADR 0006). A chat product may render the
  ask as a card, whose answering tool the host hides from the model
  ([`packages/mcp/src/tools/answer-ask.ts`](packages/mcp/src/tools/answer-ask.ts)).
- **Every exec carries its own capability token**, a short-lived EdDSA JWT naming the person, the
  agent, the connections in reach and the tool, verified statelessly by the proxy. A tool running
  for one agent cannot reach a connection that agent was never given.
- **A blob's scope is a mount, not a scan.** An agent's sandbox mounts that agent's blobs directory
  alone, so another agent's file is on no path it can name; the check's ban on `fs` and its kin is
  defence in depth over the authored code, not the boundary (ADR 0023).
- **Packages install at publish or never**, in a separate step that alone may reach npm, pinned,
  with install scripts disabled, and only if they clear the package policy (ADR 0013). A stock tool
  declares none.

### Where it stops

- **The static check is a linter, not the boundary.** The container and the network are. A module
  that defeats the check still has one route out, and it is the proxy.
- **The self-hosted server mounts the Docker socket** to create sandboxes, which is root-equivalent
  on the host. [`packages/sandbox-docker/README.md`](packages/sandbox-docker/README.md) has the
  sibling-daemon arrangement for deployments where that is not acceptable.
- **The host list is the model's proposal and your decision.** The console shows the hosts before
  the credential is entered. Waving them through widens what the proxy will allow.
- **A reviewed table is only as complete as its review.** A `POST` that changes state at an
  endpoint the read table names, or a destructive endpoint the destructive table lacks, would be
  misjudged; both tables are short, data-only files under `packages/proxy/src`, and an entry names
  the integration's documentation.
- **No third-party security audit has been done.** The design is ours, reviewed by us. Report a
  vulnerability to the address in [`SECURITY.md`](SECURITY.md), which also says what is in scope;
  never to a public issue.
- **Two people, and a young codebase.** The first commit is dated 9 September 2026 and the code
  was written with heavy coding-agent assistance under the working agreement in
  [`AGENTS.md`](AGENTS.md). Read it before you point it at an account that matters.
- **Node 24, Postgres 18 and a Docker daemon** are required, and an integration without public
  documentation is out of reach by design (ADR 0001).

## What Graft is not

- **Not a catalogue of someone else's tools, and not a broker.** The ready-made tools are Graft's
  own code, written by the same loop, run in your sandbox through your proxy; nothing upstream is
  swallowed whole, and no third party holds your credential. An integration without stock is
  reached the hard way, by reading its documentation at `acquire` time (ADR 0001 as amended
  2026-10-09).
- **Not a gateway.** It does not sit in front of your MCP servers or expose every tool of every
  app. An MCP server is one more source an agent may carve a slice from.
- **Not a harness.** It plugs into the one you already run, as the meta-tools plus exactly the
  tools currently promoted for that agent.

## Compared with

- **Composio, Nango, Arcade.** Managed connectivity and auth to a large estate of third-party
  APIs, each with its own emphasis: Composio on catalogue breadth, Nango on code-first integrations
  you write and deploy, Arcade on governing every action an agent takes. Graft ships the basics of
  thirteen integrations as reviewed code of its own and writes the rest on demand, which is the
  right trade when the integration you need is in nobody's catalogue, or the slice you need is
  smaller than the connector.
- **Superglue.** An agent that builds declarative step workflows against your systems, from its web
  app, CLI or API, and runs them on infrastructure that resolves the credentials at call time.
  Graft builds from inside the chat you are already in, emits a versioned code module rather than
  a workflow definition, and the runtime never holds the secret.
- **Zapier MCP.** A hosted MCP endpoint over Zapier's own catalogue of actions, behind a Zapier
  account and pre-enabled for the apps it already connects. Graft is a server you run yourself,
  over accounts you connect to it directly.
- **"I will just write it myself."** You will, and it will be better than what a model writes. The
  claim is about the fortieth one, at 2am, for an integration you will use twice.
- **"I will just give Claude Code the API key."** That works, and the key ends up in the
  transcript, the code and the sandbox, and what you get is a one-off script. Graft's output is a
  versioned tool with derived annotations and an approval gate, and the key stays in the keyring.

## Self-hosting

You need Docker with Compose, a model provider key (a self-hosted Graft always brings its own, ADR
0014), and a harness.

**1. Clone, pull the images and mint the secrets.**

```bash
git clone https://github.com/getmodern-ai/graft && cd graft
cp .env.example .env
docker compose pull
docker compose run --rm --no-deps graft node dist/keys.mjs >> .env
```

The pull fetches `ghcr.io/getmodern-ai/graft` and `ghcr.io/getmodern-ai/graft-sandbox`, the server
and the image sandboxes are created from, at the version `GRAFT_IMAGE_TAG` names in `.env`, `0.1.0`
as this repository ships it, for `linux/amd64` and `linux/arm64`
([`release.yml`](.github/workflows/release.yml) publishes both on a `v*` tag). Set that variable to
`latest` to follow the newest release instead. Nothing is built: the only files the pull and
everything after it need from the checkout are `docker-compose.yml` and `.env.example`. The stock
tools ship inside the server image and are loaded into its catalogue on every start.

That last line prints six `.env` lines: the three secrets Graft refuses to start without, the
capability-token key pair, and a fresh `GRAFT_ADMIN_PASSWORD`. Nothing in this repository ships a
value for any of them.

**2. Fill in `.env`.** The model group is `GRAFT_MODEL_BACKEND=provider` with `GRAFT_MODEL_PROVIDER`
(`anthropic` or `openai`) and `GRAFT_MODEL_API_KEY`; the two model ids default per provider. Graft
refuses to start without its secrets and names each one that is missing.

**Set `GRAFT_ADMIN_EMAIL` to your own address.** It is the address the bootstrapped admin signs in
with, and the password beside it is the one the keys script just minted into `.env`. The pair is
all-or-nothing, and a password under 16 characters, a secret store's placeholder, or the one this
repository shipped before the defaults were removed is refused at boot with a sentence naming the
variable. Leave both unset to register through the console's `/signup` instead.

**3. Bring it up.**

```bash
docker compose up -d
docker compose logs graft
```

Postgres first, then Graft: the server, the proxy, the MCP endpoint and the console in one
container, with the committed migrations applied on start and the admin account opened into the
empty database. A database that already holds a person is never touched. The sandbox image was
pulled alongside it, and sandboxes run on an internal network whose only other member is the proxy.

**4. Sign in, and Setup connects your harness.** Open `http://localhost:3000`, sign in as the
admin, and Setup opens: pick the harness, pick an integration, name the first task. On a self-host
the one-click starter is Open-Meteo, the keyless one; every other integration is connected through
the ordinary form, with a pasted key or an OAuth client you register with that integration (ADR
0005), and its ready-made tools are there as soon as it is. Setup ends by minting the agent's
token, shown once, with the configuration block for Hermes, OpenClaw or any MCP client, or with the
URL and steps for a chat product's consent.

```bash
echo "GRAFT_TOKEN=grft_…" >> ~/.hermes/.env
```

Skipping Setup is fine: *Agents*, *New agent* mints a token and prints the same blocks.

**5. Ask for something no tool covers.** "Get me a fresh UUID from httpbin.org", say. The agent
proposes the connection and hands you a console link to confirm it, then `acquire` runs and the new
tool appears in the harness's list as `httpbin__<name>`, first-class.

### Configuration

Every variable the server reads is documented in
[`packages/env/src/schema.ts`](packages/env/src/schema.ts) and in the commented groups of
[`.env.example`](.env.example). The ones a self-hoster reaches for:

- **Behind a domain**, `GRAFT_PUBLIC_URL` is the https origin your reverse proxy serves, and
  `GRAFT_TRUSTED_PROXY_HOPS` is how many proxies stand in front, so a rate limit keys on the real
  address rather than the proxy's.
- **On Linux**, set `GRAFT_DOCKER_GID` to `stat -c %g /var/run/docker.sock` so the unprivileged
  server can reach the daemon. Without the socket, a `docker:dind` sibling, it takes `DOCKER_HOST`.
- **Sign-in providers.** `GRAFT_GOOGLE_CLIENT_ID`/`_SECRET` and `GRAFT_GITHUB_CLIENT_ID`/`_SECRET`,
  each pair all-or-nothing and off by default, add a *Continue with* button. The redirect URI is
  your origin plus `/api/auth/callback/google` or `…/github` (ADR 0020).
- **Email.** With `GRAFT_SMTP_URL` and `GRAFT_MAIL_FROM`, verification and password-reset mail
  leaves through your own relay. Unset, the links are printed in the log (ADR 0021).
- **Large files.** `GRAFT_PROXY_MAX_BODY_BYTES` is the most bytes a request or response may carry
  through the proxy, 10 MiB unless set and never under 1 MiB. Raise it for a tool that moves
  larger files; each in-flight call may hold that much memory, and the boot line names a raised
  cap (ADR 0010).
- **Rate limits are off until you set one.** `GRAFT_RATE_LIMIT_<DOOR>=<limit>/<seconds>` per door:
  `SIGN_IN`, `OAUTH_REGISTER`, `OAUTH_TOKEN`, `MCP`, `PROXY` and `API`, counted in this process.
  `.env.example` has a starting point for each.
- **An API gateway of your own.** The `GRAFT_GATEWAY_*` group names the hosts it covers and the
  upstream and header it relays through; an integration whose hosts are all covered connects with
  no person step (ADR 0019).
- **Which chat products may answer the in-chat card.** `GRAFT_CARD_HOSTS`, by the host of their
  OAuth callback; Claude and ChatGPT by default. Any other client answers every ask in the console.
- **Nothing is reported anywhere.** The self-hosted form holds no analytics library, no log
  shipping and no model tracing, only the seams the hosted form fills from its own package (ADR
  0002). Your wide events are in `docker compose logs graft`, one per request.

**Upgrading** is `docker compose pull && docker compose up -d`: migrations apply on start, and the
toolbox lives in the `graft_toolboxes` volume, which only `docker compose down -v` removes. With
`GRAFT_IMAGE_TAG` pinned, put the version you are moving to in `.env` first; on `latest` the pull
is the upgrade. Building from the checkout instead is `git pull && docker compose up -d --build`.
`docker compose down` leaves the sandbox containers running and says so; clear them with
`docker rm -f $(docker ps -aq --filter label=graft.sandbox.prefix)`.

## Hosted and self-hosted

One core, two backings per seam, chosen by `GRAFT_BACKINGS` (ADR 0002). The hosted form's backings
live in a private package that is not in this repository, and its vendors are not named here.

| Seam | Self-hosted, in this repository | Hosted |
| --- | --- | --- |
| Sandbox | a Docker container per agent on your daemon | the hosted form's own backing |
| Keyring | AES-256-GCM envelope encryption under `GRAFT_KEYRING_SECRET` | the hosted form's own backing |
| Connection providers | the keyring: a pasted key, a keyless confirmation, or an OAuth client you register | a link provider that connects common integrations in one click, ahead of the keyring |
| Integration directory | the starters the keyring connects in one click | the link provider's catalogue, filtered to what it connects |
| Toolbox and blob store | a directory tree under `GRAFT_TOOLBOX_ROOT` | the hosted form's own backing |
| Stock tools | the same thirteen integrations, loaded from the image | the same |
| Model | your own provider key | Graft's fixed model, with a person's own key routing their jobs to their provider |
| Packages | public npm under the package policy | a curated mirror of the allowlist |
| Logs, analytics, model telemetry, rate limits | stdout, off, off, off | the hosted form's own backings |

Both forms run the same loop and the same checks. The hosted one is at
[getgraft.ai](https://getgraft.ai).

## Development

Node 24 and pnpm 10.

```bash
pnpm install
pnpm run check        # biome format and lint, writes fixes
pnpm run check-types
pnpm run test
```

Those, plus the design-token, migration-chain and image guards, are the `Typecheck, Lint & Test`
check in CI. `pnpm run test` also replays every stock tool's recorded proof through the real proxy,
with no secret. The compose file above is also the development environment. Nothing publishes
Postgres on the host by default; `pnpm run db:start` adds `docker-compose.dev.yml`, which binds it
to `127.0.0.1:5432` for a server run from source with `pnpm run dev`.
[`AGENTS.md`](AGENTS.md) lists every root command, the database loop, and how to add a package.
Contributions are accepted under the Developer Certificate of Origin: sign off each commit with
`git commit -s`. Stock tools are maintainer-built for now; [`CONTRIBUTING.md`](CONTRIBUTING.md)
says why, and [`packages/stock/README.md`](packages/stock/README.md) is the build command.

## Reading order

For a person or a coding agent arriving at this repository:

1. [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` is a symlink to it): the working agreement, and a map of
   every subsystem that names the ticket and the decision each one came from. A coding agent starts
   here and reads the next two before touching anything.
2. [`CONTEXT.md`](CONTEXT.md), the glossary. Every term in this repository is used exactly as
   defined there, and each term's *Avoid* list is binding in code, comments and copy.
3. [`docs/adr/`](docs/adr), the decision records, numbered in the order they were made and amended
   in place with a dated note. A comment in the code points at the ADR for the argument rather than
   restating it.
4. [`docs/roadmap.md`](docs/roadmap.md), the build order, the self-improvement levels and the
   deferred items, and [`docs/research/`](docs/research), the comparison with the Self-Harness
   paper that shaped the bet.
5. [`docs/reports/README.md`](docs/reports/README.md). Tickets are referenced by number as
   `GRA-…`; Linear is private, so those do not open, and this index maps each ticket to its pull
   request here. A pull request body is the build record for the ticket it closed: the contracts
   later work was told to match, what was verified by hand and what was not.

[`docs/agents/`](docs/agents) is the per-repository configuration the vendored engineering skills
under `.agents/skills/` read: the issue tracker, the triage labels and where the domain docs live.

## Lineage

The core is copied from Cando's authored-tools framework and folds in the forward-proxy shape and
SDK-rebinding recipe from Modern. Both are private repositories of the same company. Cando adopts
Graft as a dependency once its API is stable (ADR 0011).

## License

The core is Apache-2.0 ([`LICENSE`](LICENSE)). The Hermes skill and any harness plugin are MIT
([`skills/LICENSE`](skills/LICENSE)). The hosted form's backings are a private package and not in
this repository. The licensing decision record under [`docs/adr/`](docs/adr) says why.

## Listings

Graft's MCP server is listed on M8ven, a trust index that grades a server on its code, how far
it has been verified and its reputation.

[![M8ven Score](https://m8ven.ai/badge/mcp/getmodern-ai-graft-17dvr6?v=a59a00705afc5d3edd3a6e225d470821)](https://m8ven.ai/mcp/getmodern-ai-graft-17dvr6?s=readme)
