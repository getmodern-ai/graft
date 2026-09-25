# Graft

**Graft gives an agent the integration it is missing. It writes the code on demand, against the
vendor's real API, and hands the result to the agent as an MCP tool.**

Add Graft to Claude, ChatGPT, Hermes or OpenClaw as one MCP server. When the agent hits a task no
tool covers, it calls `acquire`. Graft's own coding model reads the vendor's documentation, writes
the smallest module that makes the call, checks it, proves it with reads, publishes it, dry-runs it
against the live API with every write stopped at a proxy, and promotes it into that agent's tool
list. The credential never enters the module, the sandbox or the model. When the agent stops using
the tool it leaves the list again, and stays in the toolbox one call from coming back.

Three words are used exactly as [`CONTEXT.md`](CONTEXT.md) defines them. A **harness** is the agent
software you run. A **person** is the account holder. A **connection** is one vendor account you
have given Graft.

## Connect it

**Claude and ChatGPT need no token.** Add your Graft origin plus `/mcp` as a custom connector in
Claude, or as an MCP app in ChatGPT (Plugins, then + and Create app, with Developer mode on):

```
https://your-graft.example/mcp
```

The product discovers Graft's own authorization server from that endpoint, registers itself, and
sends you to the console to consent. The consent mints the agent the connector will be, reaching
the connections you pick (ADR 0018). Revoking that agent ends it.

**Hermes and OpenClaw** carry a per-agent bearer token instead, minted in the console and shown
once. Hermes takes it in `~/.hermes/config.yaml`; OpenClaw takes the same in its JSON `mcpServers`
shape, which the console prints on every agent's page.

```yaml
mcp_servers:
  graft:
    url: "https://your-graft.example/mcp"
    headers:
      Authorization: "Bearer ${GRAFT_TOKEN}"
```

Either way the agent now lists Graft's meta-tools, `acquire`, `acquire_status`, `find_tool`,
`promote`, `demote`, `run_tool`, `request_connection` and `request_credential`, beside its own.
Hermes users can install [`skills/hermes-graft`](skills/hermes-graft), which says when to reach for
them; chat products get the same guidance in the `initialize` handshake and install nothing.

## See the loop run, with no key and no Docker

The eval harness drives the real loop against two fake vendors behind the real proxy and grades
what it did with deterministic scorers. `--scripted` plays canned model answers, so it reaches no
provider, spends nothing and needs no Docker daemon.

```bash
pnpm install
pnpm --filter @graft/evals eval -- --scripted
```

Eight seconds on an M-series laptop, exit code 0, and a scorecard. One scenario of three, abridged:

```
  PASS  write: create an order in Demo Orders   (1 attempt(s), 1800 tokens, 2s)
        ok   reads_before_publish               1 read(s) before publish
        ok   publish_before_first_write         no write reached the vendor during the job
        ok   dry_run_before_any_ask             dry run passed; 1 ask(s), 0 before it
        ok   write_previewed                    POST /v2/orders
        ok   first_write_through_published_tool POST /v2/orders under claim
                                                tool=demo__create-order, after the person's yes
        ok   credential_never_recorded          no secret in traces, attempts, status or report

  OVERALL  3/3 scenario(s) passed whole
```

The other two are a read tool and a tool built on an official SDK bound to the proxy. Drop
`--scripted` and set a provider key to run them against a real model.
[`packages/evals/README.md`](packages/evals/README.md) lists every scorer and the evidence it reads.

## What an acquisition does

1. **The agent proposes a connection** with `request_connection`, naming the vendor and the hosts
   it needs. You confirm or edit that host list in the console and enter the secret there, or
   complete an OAuth consent, or connect with no step where a provider covers the vendor.
2. **`acquire` starts a job and returns at once**; `acquire_status` reports progress. The model
   writes one module and the static check reads it back: types against the input schema, banned
   surface, imports outside the module, a literal foreign host, an SDK not bound to the proxy.
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
  is `ctx.fetch` with a vendor-relative path, which the proxy completes, signs and pins to the
  connection's declared hosts. An SDK is constructed with the capability token as its key and
  `ctx.proxyBase()` as its base, and the check refuses one bound any other way (ADR 0010).
- **A dry run lets reads through and stops every write at the proxy.** `GET` and `HEAD` reach the
  vendor; every other method stops with a 202 and a preview of the request that would have left.
  The rule is read off a claim on the capability token, so code that bypasses the runner's own
  fetch still cannot write ([`packages/proxy/src/dry-run.ts`](packages/proxy/src/dry-run.ts)).
- **The read-only and destructive annotations are derived, not claimed.**
  [`packages/check/src/annotations.ts`](packages/check/src/annotations.ts) reads them off the
  module's HTTP methods: read-only when every call is a `GET` or a `HEAD`, destructive when any is
  a `DELETE`, and a module the check could not read asks every time.
- **Secrets and approvals happen in the console, never in chat.** A meta-tool returns a handoff URL
  and waits; the person answers on a page of their own (ADR 0006). A chat product may render the
  ask as a card, whose answering tool the host hides from the model
  ([`packages/mcp/src/tools/answer-ask.ts`](packages/mcp/src/tools/answer-ask.ts)).
- **Every exec carries its own capability token**, a short-lived EdDSA JWT naming the person, the
  agent, the connections in reach and the tool, verified statelessly by the proxy. A tool running
  for one agent cannot reach a connection that agent was never given.
- **Packages install at publish or never**, in a separate step that alone may reach npm, pinned,
  with install scripts disabled, and only if they clear the package policy (ADR 0013).

### Where it stops

- **The static check is a linter, not the boundary.** The container and the network are. A module
  that defeats the check still has one route out, and it is the proxy.
- **The self-hosted server mounts the Docker socket** to create sandboxes, which is root-equivalent
  on the host. [`packages/sandbox-docker/README.md`](packages/sandbox-docker/README.md) has the
  sibling-daemon arrangement for deployments where that is not acceptable.
- **The host list is the model's proposal and your decision.** The console shows the hosts before
  the credential is entered. Waving them through widens what the proxy will allow.
- **No third-party security audit has been done.** The design is ours, reviewed by us. Report a
  vulnerability to the address in `SECURITY.md`, which also says what is in scope; never to a
  public issue.
- **One maintainer, and a young codebase.** The first commit is dated 9 September 2026 and the
  code was written with heavy coding-agent assistance under the working agreement in
  [`AGENTS.md`](AGENTS.md). Read it before you point it at an account that matters.
- **Node 24, Postgres 18 and a Docker daemon** are required, and a vendor without public
  documentation is out of reach by design (ADR 0001).

## What Graft is not

- **Not a catalogue.** No pre-built integration library, no broker behind it. The model does the
  research, per person, per need.
- **Not a gateway.** It does not sit in front of your MCP servers or expose every tool of every
  app. An MCP server is one more source an agent may carve a slice from.
- **Not a harness.** It plugs into the one you already run, as the meta-tools plus exactly the
  tools currently promoted for that agent.

## Compared with

- **Composio, Nango, Arcade.** Managed connectivity and auth to a large estate of third-party
  APIs, each with its own emphasis: Composio on catalogue breadth, Nango on code-first integrations
  you write and deploy, Arcade on governing every action an agent takes. Graft ships no catalogue
  and writes the one integration you asked for, which is the right trade only when the vendor you
  need is in nobody's catalogue, or the slice you need is smaller than the connector.
- **Superglue.** An agent that builds declarative step workflows against your systems, from its web
  app, CLI or API, and runs them on infrastructure that resolves the credentials at call time.
  Graft builds from inside the chat you are already in, emits a versioned code module rather than
  a workflow definition, and the runtime never holds the secret.
- **Zapier MCP.** A hosted MCP endpoint over Zapier's own catalogue of actions, behind a Zapier
  account and pre-enabled for the apps it already connects. Graft is a server you run yourself,
  over accounts you connect to it directly.
- **"I will just write it myself."** You will, and it will be better than what a model writes. The
  claim is about the fortieth one, at 2am, for a vendor you will use twice.
- **"I will just give Claude Code the API key."** That works, and the key ends up in the
  transcript, the code and the sandbox, and what you get is a one-off script. Graft's output is a
  versioned tool with derived annotations and an approval gate, and the key stays in the keyring.

## Self-hosting

You need Docker with Compose, a model provider key (a self-hosted Graft always brings its own, ADR
0014), and a harness.

**1. Clone, build and mint the secrets.**

```bash
git clone https://github.com/getmodern-ai/graft && cd graft
cp .env.example .env
docker compose build graft
docker compose run --rm --no-deps graft node dist/keys.mjs >> .env
```

That last line prints six `.env` lines: the three secrets Graft refuses to start without, the
capability-token key pair, and a fresh `GRAFT_ADMIN_PASSWORD`. Nothing in this repository ships a
value for any of them.

`.github/workflows/release.yml` publishes `ghcr.io/getmodern-ai/graft` and
`ghcr.io/getmodern-ai/graft-sandbox` on a `v*` tag. There is no tag yet, so build from the checkout.

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
docker compose up -d --build
docker compose logs graft
```

Postgres first, then Graft: the server, the proxy, the MCP endpoint and the console in one
container, with the committed migrations applied on start and the admin account opened into the
empty database. A database that already holds a person is never touched. The sandbox image is built
alongside, and sandboxes run on an internal network whose only other member is the proxy.

**4. Create an agent.** Open `http://localhost:3000`, sign in as the admin, then *Agents*, *New
agent*. The token is shown once; put it where your harness reads environment variables, point the
harness at `http://localhost:3000/mcp` with the block from [Connect it](#connect-it) above, and
reload its MCP servers.

```bash
echo "GRAFT_TOKEN=grft_…" >> ~/.hermes/.env
```

**5. Ask for something no tool covers.** "Get me a fresh UUID from httpbin.org", say. The agent
proposes the connection and hands you a console link to confirm it, then `acquire` runs and the new
tool appears in the harness's list as `httpbin__<name>`, first-class.

### Configuration

Every variable the server reads is documented in
[`packages/env/src/schema.ts`](packages/env/src/schema.ts) and in the commented groups of
[`.env.example`](.env.example). The ones a self-hoster reaches for:

- **Behind a domain**, `GRAFT_PUBLIC_URL` is the https origin your reverse proxy serves.
- **On Linux**, set `GRAFT_DOCKER_GID` to `stat -c %g /var/run/docker.sock` so the unprivileged
  server can reach the daemon. Without the socket, a `docker:dind` sibling, it takes `DOCKER_HOST`.
- **Sign-in providers.** `GRAFT_GOOGLE_CLIENT_ID`/`_SECRET` and `GRAFT_GITHUB_CLIENT_ID`/`_SECRET`,
  each pair all-or-nothing and off by default, add a *Continue with* button. The redirect URI is
  your origin plus `/api/auth/callback/google` or `…/github` (ADR 0020).
- **Email.** With `GRAFT_SMTP_URL` and `GRAFT_MAIL_FROM`, verification and password-reset mail
  leaves through your own relay. Unset, the links are printed in the log (ADR 0021).
- **Large files.** `GRAFT_PROXY_MAX_BODY_BYTES` is the most bytes a vendor request or response may
  carry through the proxy, 10 MiB unless set and never under 1 MiB. Raise it for a tool that moves
  larger files; each in-flight call may hold that much memory, and the boot line names a raised
  cap (ADR 0010).
- **Nothing is reported anywhere.** The self-hosted form holds no analytics library, no log
  shipping and no model tracing, only the seams the hosted form fills from its own package (ADR
  0002). Your wide events are in `docker compose logs graft`, one per request.

**Upgrading**, while the images are built from the checkout, is `git pull && docker compose up -d
--build`: migrations apply on start, and the toolbox lives in the `graft_toolboxes` volume, which
only `docker compose down -v` removes.
`docker compose down` leaves the sandbox containers running and says so; clear them with
`docker rm -f $(docker ps -aq --filter label=graft.sandbox.prefix)`.

## Hosted and self-hosted

One core, two backings per seam, chosen by `GRAFT_BACKINGS` (ADR 0002). The hosted form's backings
live in a private package that is not in this repository, and its vendors are not named here.

| Seam | Self-hosted, in this repository | Hosted |
| --- | --- | --- |
| Sandbox | a Docker container per agent on your daemon | the hosted form's own backing |
| Keyring | AES-256-GCM envelope encryption under `GRAFT_KEYRING_SECRET` | the hosted form's own backing |
| Toolbox | a directory tree under `GRAFT_TOOLBOX_ROOT` | the hosted form's own backing |
| Model | your own provider key | Graft's fixed model, with a person's own key routing their jobs to their provider |
| Packages | public npm under the package policy | a curated mirror of the allowlist |
| Logs, analytics, model telemetry | stdout, off, off | the hosted form's own backings |

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
check in CI. The compose file above is also the development environment. Nothing publishes Postgres
on the host by default; `pnpm run db:start` adds `docker-compose.dev.yml`, which binds it to
`127.0.0.1:5432` for a server run from source with `pnpm run dev`.
[`AGENTS.md`](AGENTS.md) lists every root command, the database loop, and how to add a package.
Contributions are accepted under the
Developer Certificate of Origin: sign off each commit with `git commit -s`.

## Reading order

1. [`CONTEXT.md`](CONTEXT.md), the glossary. Every term here is used exactly as defined there.
2. [`docs/adr/`](docs/adr), the decision records, numbered in the order they were made.
3. [`docs/roadmap.md`](docs/roadmap.md), the build order, the self-improvement levels and the
   deferred items, and [`docs/research/`](docs/research), the comparison with the Self-Harness
   paper that shaped the bet.

Tickets are referenced by number as `GRA-…`. Linear is private, so those do not open;
[`docs/reports/README.md`](docs/reports/README.md) maps each ticket to its pull request here, and a
pull request body is the build record for the ticket it closed.

## Lineage

The core is copied from Cando's authored-tools framework and folds in the forward-proxy shape and
SDK-rebinding recipe from Modern. Both are private repositories of the same company. Cando adopts
Graft as a dependency once its API is stable (ADR 0011).

## License

The core is Apache-2.0 ([`LICENSE`](LICENSE)). The Hermes skill and any harness plugin are MIT
([`skills/LICENSE`](skills/LICENSE)). The hosted form's backings are a private package and not in
this repository. The licensing decision record under [`docs/adr/`](docs/adr) says why.
