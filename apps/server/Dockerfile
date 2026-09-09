# syntax=docker/dockerfile:1

# The self-hosted form (ADR 0002; GRA-33): one image carrying the server, the proxy, the MCP
# endpoint and the console, run by `docker-compose.yml` at the repository root beside Postgres and
# the sandbox image. Built from the repository root: `docker build -f apps/server/Dockerfile .`
#
# Five stages. `manifests` and `deps` exist so that the dependency install is a cache hit on every
# commit that leaves the lockfile alone: the install layer sees only the package manifests, copied
# with their paths kept, so an edit to a source file cannot invalidate it. `build` compiles the
# console and bundles the server; `prod-deps` installs what the bundle imports at run time and
# nothing else; `runtime` is Node on Debian slim with a dedicated user and the four directories the
# server needs.

FROM node:24-slim AS base
# The pnpm the lockfile was written with — `packageManager` in the root package.json.
RUN npm install -g pnpm@10.6.1
WORKDIR /app

# Every package.json in the workspace, at its own path, and nothing else. `find` rather than one
# COPY line per workspace, because a list rots the moment a package is added and pnpm accepts a
# missing manifest silently — the gap would surface as a missing module at run time.
FROM base AS manifests
COPY . /src
RUN mkdir -p /manifests \
 && cd /src \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests \; \
 && cp pnpm-lock.yaml pnpm-workspace.yaml /manifests/

FROM base AS deps
COPY --from=manifests /manifests ./
RUN --mount=type=cache,id=graft-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

# The console's `vite build` and the server's `tsdown` bundle (`apps/server/tsdown.config.ts`, which
# also lays the runner, the skills and the migration chain beside the bundle).
FROM deps AS build
COPY . .
RUN pnpm --filter @graft/web build \
 && pnpm --filter @graft/server build

# The bundle inlines every `@graft/*` package and imports every third-party dependency as written,
# so the runtime needs the production dependencies of the server *and* of each workspace package it
# inlines, resolvable from one place. `node-linker=hoisted` lays them flat under `/app/node_modules`
# — the layout npm would make — which is what lets `typescript6` (declared by `@graft/check`) and
# `tar-stream` (by `@graft/sandbox-docker`) resolve from the server's directory. The lockfile holds
# one version of each, so hoisting decides nothing.
FROM base AS prod-deps
COPY --from=manifests /manifests ./
RUN --mount=type=cache,id=graft-pnpm-store,target=/pnpm-store \
    pnpm install --prod --frozen-lockfile --store-dir /pnpm-store \
      --config.node-linker=hoisted --filter "@graft/server..."

FROM node:24-slim AS runtime

# The same uid as the sandbox user (`packages/sandbox-docker/Dockerfile`, `SANDBOX_UID`), on
# purpose: sandboxes write drafts into the shared toolbox as 10001, and a server that is the same
# user can remove them. A dedicated user rather than root because the process holds the daemon's
# socket, which is root-equivalent on the host (ADR 0002); the container should add nothing to that.
RUN groupadd --gid 10001 graft \
 && useradd --uid 10001 --gid graft --create-home --shell /usr/sbin/nologin graft \
 && mkdir -p /var/lib/graft/toolboxes \
 && chown -R graft:graft /var/lib/graft

WORKDIR /app
COPY --from=prod-deps --chown=graft:graft /app/node_modules ./node_modules
COPY --from=build --chown=graft:graft /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=graft:graft /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=graft:graft /app/apps/server/skills ./apps/server/skills
COPY --from=build --chown=graft:graft /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=graft:graft /app/apps/web/dist ./apps/web/dist

# What the image knows about itself; everything a deployment decides comes from the environment
# (`packages/env/src/schema.ts`), and the compose file is the reference for that. The console
# directory is the default `../web/dist` made absolute; the toolbox root is the named volume's
# mount point in the compose file.
ENV NODE_ENV=production \
    PORT=3000 \
    GRAFT_CONSOLE_DIR=/app/apps/web/dist \
    GRAFT_TOOLBOX_ROOT=/var/lib/graft/toolboxes

USER graft
WORKDIR /app/apps/server
EXPOSE 3000

# `dist/keys.mjs` beside it mints the secrets a `.env` needs:
#   docker compose run --rm --no-deps graft node dist/keys.mjs
CMD ["node", "dist/index.mjs"]
