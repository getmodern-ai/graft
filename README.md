# Graft

**The agent grows the tools it needs onto its harness, and prunes what it stops using.**

Graft is a self-extending integration loop for people who run their own agent in
[OpenClaw](https://docs.openclaw.ai) or [Hermes](https://hermes-agent.nousresearch.com). When the
agent hits a task no tool covers, it asks Graft to acquire one. Graft's own coding model reads the
vendor's documentation, writes the smallest module that makes the call, checks it, dry-runs it
against the live API with writes stopped at a proxy, publishes it, and promotes it into that agent's
tool list. The credential never enters the code, the sandbox or the model. Later, when the agent
stops using the tool, it leaves the list again.

## What Graft is not

- **Not a catalog.** There is no pre-built integration library and no broker behind it. The model
  does the research, per person, per need.
- **Not a gateway.** Graft does not sit in front of your MCP servers and does not expose every tool
  of every app. An MCP server is one more source the agent may carve a slice from.
- **Not a harness.** It plugs into the one you already run, over MCP, as a handful of meta-tools
  plus exactly the tools currently promoted for that agent.

## How it will be used

One entry in the harness's MCP server list, pointing at Graft with a per-agent token, and one thin
skill that tells the agent: *when no tool covers the ask, call `acquire`.* Secrets and approvals
happen in a small web console the agent hands the person a link to. Reads never ask; any other tool,
destructive included, asks once per agent and the answer holds, and the person may set a tool to ask
every time instead (ADR 0008, amended 2026-09-15).

Two forms, one core: **Graft Cloud**, hosted, and a **Docker image** for self-hosting. Both run
the same loop; they differ only in which sandbox, keyring and storage sit behind the seams.

## Status

Design complete, the workspace scaffolded, the first slices under way. The design was settled in one
session on 8 and 9 September 2026 and is recorded as one architecture decision record per decision
under `docs/adr/`. The order of work and the roadmap are in `docs/roadmap.md`. Read `CONTEXT.md`
first for the vocabulary.

## Self-hosting

Ten minutes from a machine with Docker to a Hermes agent that acquires its own tools. You need
Docker 26 or later with Compose, a model provider key — the self-hosted form always brings its own
(ADR 0014) — and a harness, Hermes or OpenClaw.

**1. Get the compose file and mint the secrets.** The repository holds `docker-compose.yml`, its
`.env.example`, and the sandbox image's Dockerfile; nothing else is needed from it.

```bash
git clone https://github.com/getmodern-ai/graft && cd graft
cp .env.example .env
docker compose run --rm --no-deps graft node dist/keys.mjs >> .env   # five secrets, one line each
```

Open `.env` and fill the model group — `GRAFT_MODEL_BACKEND=provider`, `GRAFT_MODEL_PROVIDER`,
`GRAFT_MODEL_API_KEY`, `GRAFT_MODEL_AUTHORING`, `GRAFT_MODEL_TRIAGE` — and change
`GRAFT_ADMIN_EMAIL` and `GRAFT_ADMIN_PASSWORD` from the defaults. Graft refuses to start without the
secrets, and says which are missing; the same refusal for a missing model key (ADR 0014) arrives with
the provider adapter (GRA-31).

**2. Bring it up.**

```bash
docker compose up -d
docker compose logs graft        # "migrations: … applied", then "admin … created"
```

Postgres, then Graft — the server, the proxy, the MCP endpoint and the console in one container —
with the committed migrations applied on start and the admin opened into the empty database. The
sandbox image is built alongside; sandboxes are created from it on an internal network whose only
other member is the proxy (ADR 0013).

**3. Sign in and create an agent.** Open `http://localhost:3000`, sign in as the admin, then
*Agents → New agent*. The door is one screen: an address it has never seen is registered on the
same submit that signs everyone else in. To offer *Continue with Google* or *Continue with GitHub*
beside it, register an OAuth client with the vendor — redirect URI `<your origin>/api/auth/callback/google`
or `…/github` — and set its `GRAFT_GOOGLE_CLIENT_ID`/`_SECRET` or `GRAFT_GITHUB_CLIENT_ID`/`_SECRET`
pair in `.env` (each pair all-or-nothing; ADR 0020 has the linking rule). A forgotten password is
reset from *Forgot password?*: the self-hosted form prints the reset link in `docker compose logs
graft` (ADR 0021 — the console transport is the open form's mail stack). Then The token is shown once; put it where your harness reads environment
variables — for Hermes, `~/.hermes/.env`:

```bash
echo "GRAFT_TOKEN=grft_…" >> ~/.hermes/.env
```

**4. Point Hermes at it.** In `~/.hermes/config.yaml`, under `mcp_servers`, then `/reload-mcp` in
a session (or restart Hermes):

```yaml
mcp_servers:
  graft:
    url: "http://localhost:3000/mcp"
    headers:
      Authorization: "Bearer ${GRAFT_TOKEN}"
```

Hermes now lists Graft's meta-tools — `acquire`, `find_tool`, `promote`, `demote`, `run_tool` and
the rest — beside its own.

**5. Ask for something no tool covers.** "Fetch my IP from httpbin.org and tell me what it is", say.
The agent proposes a connection (`request_connection`) and hands you a link into the console to
confirm it; then `acquire` reads the vendor's documentation, writes the module, checks it, dry-runs it
against the live API with writes stopped at the proxy, publishes it and promotes it — and the new
tool appears in Hermes's list as `httpbin__<name>`, first-class. Secrets are entered in the console,
never in the chat (ADR 0006).

**OpenClaw** takes the same block in its JSON `mcpServers` shape — `{"graft": {"type": "http", "url":
"http://localhost:3000/mcp", "headers": {"Authorization": "Bearer ${GRAFT_TOKEN}"}}}` — and expands
`${GRAFT_TOKEN}` from its environment; the console shows this form on every agent's page. The
GRA-25 spike confirmed the static bearer header and lazy `tools/list_changed` handling; OpenClaw has
no MCP elicitation, so approvals arrive as console links.

**Claude and ChatGPT** need no token at all: add `http://localhost:3000/mcp` (or your deployment's
origin plus `/mcp`) as a custom connector, and the product discovers Graft's own authorization server
from the endpoint, registers itself and sends you to the console, where the consent page mints the
agent the connection will be — named for the product, with the scope you pick — or names one you
already have (ADR 0018). Revoking that agent ends the connection; the product asks you to connect again.

**Behind a domain**, set `GRAFT_PUBLIC_URL` in `.env` to the https origin your reverse proxy serves,
and put that proxy in front of port 3000. **On Linux**, set `GRAFT_DOCKER_GID` to
`stat -c %g /var/run/docker.sock` so the unprivileged server can reach the daemon. **Without the
socket** — a Docker daemon in a sibling container, `docker:dind` — the server takes `DOCKER_HOST`
instead; `packages/sandbox-docker/README.md` describes that arrangement and what has to live inside
the sibling daemon. **Upgrading** is `docker compose pull && docker compose up -d`: migrations apply
on start and the toolbox lives in the `graft_toolboxes` volume, which only `docker compose down -v`
removes. **Stopping** is `docker compose down`; the sandboxes the server created are containers of
their own, `graft-sandbox-agent-<id>`, still attached to the sandbox network, and `down` says so
rather than removing them — `docker rm -f $(docker ps -aq --filter label=graft.sandbox.prefix)`
first, or leave them for the next `up`, which finds them again.

## Development

Node 24 and pnpm 10. `pnpm install`, then `pnpm run check` (format and lint), `pnpm run check-types`
and `pnpm run test`; the same three run in CI as the `Typecheck, Lint & Test` check. The compose file
above is the development environment too: `pnpm run db:start` brings up its Postgres alone for a
server run from source, and `docker compose up -d --build` runs the whole thing as a self-hoster
gets it. `AGENTS.md` lists every root command and how to add a package. Contributions are under the agreement in
`CLA.md`, signed once on your first pull request.

## Reading order

1. `CONTEXT.md`: the glossary. Every term below is used exactly as defined there.
2. `docs/adr/`: sixteen decisions, numbered in the order they were made.
3. `docs/roadmap.md`: the build order, the self-improvement levels, and the deferred items.
4. `docs/research/`: the teardown of executor.sh and the comparison with the Self-Harness paper
   that shaped the bet.

## Lineage

The core is copied from [Cando](https://github.com/getmodern-ai/cando)'s authored-tools framework
(ADRs 0025 to 0029 there) and folds in the forward-proxy shape and SDK-rebinding recipe from
Modern. Cando adopts Graft as a dependency once its API is stable (ADR 0011).

## License

The core server is AGPL-3.0. The skill and any harness plugin ship under MIT. The hosted backings
are private. See ADR 0015 for why, and for the conditions under which this changes.
