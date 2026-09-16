# GRA-33 interface half (one image and a compose file), pushed at f1b597c on `aleks/gra-33-image-and-compose` (stacked on gra-26-console)

Saved by the orchestrator from the implementing agent's interim report, 2026-09-09. PR opening; the loop criterion waits for GRA-29 and GRA-31 to be merged into the branch. Final report will be `gra-33-report.md`.

## Image

`apps/server/Dockerfile` built from the repo root; runtime `node:24-slim` as user `graft` (uid 10001), `WORKDIR /app/apps/server`, `CMD node dist/index.mjs`, `EXPOSE 3000`. Image ENV: `NODE_ENV=production`, `PORT=3000`, `GRAFT_CONSOLE_DIR=/app/apps/web/dist`, `GRAFT_TOOLBOX_ROOT=/var/lib/graft/toolboxes`. `node dist/keys.mjs` mints the five secrets. Liveness `GET /api/health` → `{"ok":true}`. Migrations run on start (`GRAFT_MIGRATE_ON_START`, default true); admin bootstrap from `GRAFT_ADMIN_EMAIL` + `GRAFT_ADMIN_PASSWORD` (all-or-nothing, acts only on an empty database). Measured: 547 MB (arm64), cold start 1.38 s to health.

## Compose

Services: `postgres` (postgres:18, volume `graft_postgres_data`, host port `${GRAFT_POSTGRES_PORT:-5432}`), `graft` (image `ghcr.io/getmodern-ai/graft:${GRAFT_IMAGE_TAG:-latest}`, host port `${GRAFT_PORT:-3000}`), `sandbox` (scale 0; builds `ghcr.io/getmodern-ai/graft-sandbox:${GRAFT_IMAGE_TAG:-latest}`). Networks: `default`, `sandbox` (`internal: true`, compose-named `<project>_sandbox`, `graft` joins under alias `proxy`). Volumes: `<project>_graft_postgres_data`, `<project>_toolboxes`.

Env the `graft` service sets: `GRAFT_DATABASE_URL=postgresql://postgres:<pw>@postgres:5432/graft`, `GRAFT_AUTH_URL` and `GRAFT_CONSOLE_URL=${GRAFT_PUBLIC_URL:-http://localhost:3000}`, `GRAFT_PROXY_PUBLIC_URL=http://proxy:3000/api/proxy`, `GRAFT_SANDBOX_IMAGE`, `GRAFT_SANDBOX_NETWORK=<project>_sandbox`, `GRAFT_TOOLBOX_VOLUME=<project>_toolboxes` (new env var: the named volume `GRAFT_TOOLBOX_ROOT` is mounted from; the Docker backing then mounts each toolbox into its sandbox as a subpath of that one volume, new option `toolboxVolume`, Engine API bumped to 1.45 / Docker 26), `GRAFT_ADMIN_EMAIL`/`PASSWORD` defaults. Everything else from `.env` via `env_file` (`.env.example` committed). Socket: `/var/run/docker.sock` mounted with `group_add ${GRAFT_DOCKER_GID:-0}`.

## Refuse-to-start

In production on open backings the model group (`GRAFT_MODEL_BACKEND=provider`, `GRAFT_MODEL_PROVIDER`, `GRAFT_MODEL_API_KEY`, `GRAFT_MODEL_AUTHORING`, `GRAFT_MODEL_TRIAGE`) is required, written against GRA-31's names.

## Verified so far

compose up, migrations, admin created, console, sign-in, agent token, 16 meta-tools over MCP, `run_command` in a sandbox (proxy reachable, egress ENETUNREACH), the shared toolbox tree, conformance suite 32/32 against the compose network.
