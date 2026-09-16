# GRA-33 final report (one Docker image and a compose file run the whole loop), PR #17

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Branch `aleks/gra-33-image-and-compose`, final SHA `e8e4d24`, merged into `main` as `4e8eebe`. Approved by sebapoole, CI green, Greptile silent. Supersedes `gra-33-interface.md`. Commits after the two merges of main: boot/env/health (`838ecf2`), the backing's shared toolbox volume (`2fd585a`), image/compose/CI/docs (`f1b597c`), merge of GRA-20/26/28 (`605faf1`), the rule hand-off to GRA-31 (`698a4ba`), merge of GRA-29 (`d073647`), CI smoke fix (`e8e4d24`).

## The image, `apps/server/Dockerfile` (built from the repository root)

Five stages: **`manifests`** (every `package.json` at its path via `find … cp --parents`, so the install layer is a cache hit on any commit that leaves the lockfile alone), **`deps`** (`pnpm install --frozen-lockfile`), **`build`** (`vite build` for the console, `tsdown` for the server; `apps/server/tsdown.config.ts` inlines `@graft/*`, leaves every third-party import external, and lays the four `import.meta.url`-resolved things where the constants expect them: `dist/runner.mjs`, `skills/`, `drizzle/`, and `@graft/check`'s worker as a second entry; `dist/keys.mjs` is a third entry that mints a `.env`'s secrets without pnpm), **`prod-deps`** (`pnpm install --prod … --config.node-linker=hoisted --filter "@graft/server..."`, flat under `/app/node_modules` so `typescript6` and `tar-stream` resolve from the server's directory), **`runtime`** (`node:24-slim`, user `graft` uid 10001, the sandbox user's uid so drafts sandboxes write are the server's to remove; `WORKDIR /app/apps/server`, `CMD node dist/index.mjs`, `EXPOSE 3000`, image ENV `NODE_ENV=production PORT=3000 GRAFT_CONSOLE_DIR=/app/apps/web/dist GRAFT_TOOLBOX_ROOT=/var/lib/graft/toolboxes`).

**Measured:** image 547 MB (arm64, local build; `node_modules` 301 MB, bundle + console + skills + migrations under 2 MB); sandbox image 255 MB. Cold start 1.38 s from `docker compose start graft` to `GET /api/health` 200, with the migration chain checked and applied on the way. Recorded on GRA-33 as a Linear comment.

## The compose file, `docker-compose.yml` (replaces the Postgres-only one; `pnpm run db:*` still works)

- **Services:** `postgres` (postgres:18, host port `${GRAFT_POSTGRES_PORT:-5432}`, `pg_isready` health check); `graft` (`image: ghcr.io/getmodern-ai/graft:${GRAFT_IMAGE_TAG:-latest}` with `build:` from the repo, host port `${GRAFT_PORT:-3000}`, `GET /api/health` health check, waits for Postgres healthy, `env_file: .env`); `sandbox` (`scale: 0`; builds `packages/sandbox-docker` under the name `GRAFT_SANDBOX_IMAGE` carries, starts nothing). No `container_name`, so `-p <name>` runs a second copy beside the first.
- **Networks:** `default`; `sandbox` (`internal: true`, compose-named `<project>_sandbox`), which `graft` joins under the alias `proxy`.
- **Volumes:** `graft_postgres_data` (same key as before, so existing databases survive) and `toolboxes` (`<project>_toolboxes`), mounted whole into `graft` at `GRAFT_TOOLBOX_ROOT`.
- **Env set by the service:** `GRAFT_DATABASE_URL=postgresql://postgres:<pw>@postgres:5432/graft`, `GRAFT_AUTH_URL` and `GRAFT_CONSOLE_URL=${GRAFT_PUBLIC_URL:-http://localhost:3000}`, `GRAFT_PROXY_PUBLIC_URL=http://proxy:3000/api/proxy`, `GRAFT_SANDBOX_IMAGE`, `GRAFT_SANDBOX_NETWORK=<project>_sandbox`, `GRAFT_TOOLBOX_VOLUME=<project>_toolboxes` (new), `GRAFT_ADMIN_EMAIL`/`GRAFT_ADMIN_PASSWORD` with development defaults. Everything else (the five secrets, the model group by GRA-31's names, `GRAFT_PUBLIC_URL`, ports, `GRAFT_DOCKER_GID`) comes from `.env` (`.env.example` committed).
- **Socket:** `/var/run/docker.sock` mounted (arrangement 1 of `packages/sandbox-docker/README.md`) with `group_add: ${GRAFT_DOCKER_GID:-0}` (`0` under Docker Desktop, the socket's gid on Linux). Arrangement 2 (`docker:dind`) documented in the README.

**The shared toolbox tree** needed a new backing option: a containerised server cannot bind `GRAFT_TOOLBOX_ROOT/<toolbox>` from the host, and per-toolbox volumes are a tree the server never sees. `@graft/sandbox-docker` gained `toolboxVolume`: one named volume mounted whole into the server and into each sandbox as its own subpath (`VolumeOptions.Subpath`, Engine API bumped to 1.45 / Docker 26); the subdirectory is made by a short-lived container; a volume the daemon does not have is refused by name; `mountToolbox` compares and keeps `HostConfig.Mounts`. Wired in `openBackings` (`apps/server/src/backings.ts`). Docker suite 56 cases green.

## Migrations and the admin (`apps/server/src/boot.ts`)

On start, before listening: the committed chain is checked for holes (`@graft/db`'s `migration-chain.ts`; a hole refuses the start listing the problems), then drizzle's migrator applies what the database has not seen (idempotent; `GRAFT_MIGRATE_ON_START=false` for the `db:push` loop). Proven forward-applying across three restarts of one database (chain 1 → 2 → 3). Then, if `GRAFT_ADMIN_EMAIL` + `GRAFT_ADMIN_PASSWORD` (all-or-nothing) are set and the database holds no person (`countPersons`, the third pinned unscoped read), the account is opened through Better Auth's `signUpEmail`; a populated database prints `admin bootstrap skipped: the database already holds N person(s)` and is never touched. `GET /api/health` → `{"ok":true}` is the liveness probe.

## Refuse-to-start (`packages/env`)

`describeEnvIssues` + `onValidationError` in `server.ts` print one line per problem with the variable named and exit 1. No environment:

```
graft refused to start: the environment is invalid.

GRAFT_DATABASE_URL is not set
GRAFT_AUTH_SECRET is not set
GRAFT_AUTH_URL must be an absolute http(s) URL — the server's public origin
GRAFT_CONSOLE_URL must be an absolute http(s) URL — where the console answers, the base of every handoff URL
GRAFT_HANDOFF_SECRET is not set
```

Every field but the keyring secret → `GRAFT_KEYRING_SECRET is required with the open backings …` (GRA-20's cross-field rule, which zod runs only once every field is present; hence CI's smoke is two runs). **The model-key refusal (ADR 0014) is GRA-31's rule** by the orchestrator's decision; the stub and its todo test were removed in `698a4ba`. Compose, `.env.example` and README document `GRAFT_MODEL_BACKEND=provider`, `GRAFT_MODEL_PROVIDER`, `GRAFT_MODEL_API_KEY`, `GRAFT_MODEL_AUTHORING`, `GRAFT_MODEL_TRIAGE`, optional `GRAFT_MODEL_BASE_URL`.

## Egress assertion

`packages/sandbox-docker/src/compose.test.ts` runs `@graft/sandbox`'s conformance suite against a running compose project (opt-in by `GRAFT_COMPOSE_NETWORK` + `GRAFT_SANDBOX_IMAGE`, declared in `turbo.json`). Against `graft-gra33_sandbox` with the real server under the alias `proxy`: 32 passed, the four egress cases included (proxy 200, external IP `ENETUNREACH`, external name unresolvable, detached probe fails).

## CI and release

`ci.yml`: builds the server image and asserts the two refuse-to-start runs. `release.yml`: on a `v*` tag pushes `ghcr.io/getmodern-ai/graft` and `ghcr.io/getmodern-ai/graft-sandbox` for `linux/amd64,linux/arm64` (semver tags, `latest` for non-prereleases, `sha-` tag).

## README "Self-hosting", the commands a user runs

```bash
git clone https://github.com/getmodern-ai/graft && cd graft
cp .env.example .env
docker compose run --rm --no-deps graft node dist/keys.mjs >> .env   # five secrets
# edit .env: the GRAFT_MODEL_* group and the admin email/password
docker compose up -d
docker compose logs graft        # "migrations: … applied", then "admin … created"
```

Then sign in at `http://localhost:3000`, Agents → New agent, `echo "GRAFT_TOKEN=grft_…" >> ~/.hermes/.env`, and in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  graft:
    url: "http://localhost:3000/mcp"
    headers:
      Authorization: "Bearer ${GRAFT_TOKEN}"
```

(`/reload-mcp`.) The OpenClaw paragraph gives the JSON `mcpServers` shape with the same bearer header and GRA-25's findings. Also covered: behind a domain (`GRAFT_PUBLIC_URL`), Linux (`GRAFT_DOCKER_GID`), the dind alternative, upgrading, stopping (sandbox containers hold the network; the README gives the `docker rm -f` line). AGENTS.md's Commands section points at the compose file; `packages/sandbox-docker/README.md` and `packages/toolbox/README.md` describe the shared volume.

## Verified by hand (project `graft-gra33`, ports 3033/5443, `NODE_ENV=development`)

- `docker compose up -d --build` → both services healthy; console served at `/` and on deep links; admin sign-in; agent token minted; 16 meta-tools listed over Streamable HTTP with the bearer.
- `run_command` in a sandbox created over the socket by the unprivileged server: uid 10001, `/tools` owned by `graft`, proxy 200, egress refused; `write_file` from the sandbox visible in the server container (one tree).
- **The loop** (scripted model via a local override): httpbin connection registered and scoped → `acquire` → `awaiting_approval` (build ask) → answered via `POST /api/pending-actions/:id/answer` → job queued → `acquire_status` `succeeded` after one attempt (published `httpbin__get-ip` v1, dry run passed, promoted) → 18 tools including `httpbin__get-ip` (`readOnlyHint: true`) → calling it returned `{"origin":"…"}`; the version at `/var/lib/graft/toolboxes/<person>/tools/httpbin/get-ip/v1/` inside the server container.
- Full gate on the final tree: `check`, `lint`, `check-types` 17/17, `db:check-chain`, `test --force` 16/16 `Cached: 0` (pre-merge) and env 46 / db 101 / server 85 after the last merge; CI green.

## Deferred

- BYO-key form of the loop criterion → GRA-31 (provider adapter and the model-key refusal); the loop ran with the scripted model.
- A literal Hermes instance was not run (installs into `~/.hermes`, needs a provider key first); the SDK client Hermes embeds was used with the same transport and header.
- The image's `node_modules` carries better-auth's and evlog's optional peers (~150 MB); `auto-install-peers=false` is refused by the frozen lockfile; pruning is a follow-up.
- `docker compose down` refuses the sandbox network while the server's sandbox containers exist; documented; whether the server should destroy them on SIGTERM is a design question outside the ticket.
- A second compose project adopts an unlabelled pre-existing volume of the same name without complaint; harmless, noted.

Cleanup: the agent's compose project, sandbox container, networks, volumes and local image tags removed; `graft-postgres` untouched.
