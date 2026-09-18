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
#
# The same file builds the hosted image (GRA-38). The hosted form's backings are a private package
# a checkout links in at `packages/cloud-backings/` — gitignored, so never in this repository's
# tree, present in the build context only when the checkout has it (ADR 0002). Three places below
# read that directory and do nothing when it is absent: `build` runs the package's own build,
# `prod-deps` installs its third-party dependencies because they are in the lockfile it is given, and
# `runtime` copies its build and its manifest. The open image is built from the same lines.

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

# The console's `vite build`, the ask card's (`packages/ask-card`, GRA-84: one HTML file the MCP
# server serves as a resource) and the server's `tsdown` bundle (`apps/server/tsdown.config.ts`,
# which also lays the runner, the skills, the migration chain and that card beside the bundle). The
# card is built before the server because the server's build copies its output.
#
# Then the linked backings package, when there is one: the server's bundle loads it by name at run
# time (`apps/server/src/backings.ts`) from an image that has no TypeScript, so the package has to
# arrive built — its own `build` script, which inlines the `@graft/*` seam packages it imports the
# way the server's bundle does, since the runtime has no source copy of them to resolve. When the
# directory is absent the filter matches no project and pnpm exits 0 saying so, which is what makes
# the line inert for the open image.
#
# The build and the manifest are then staged under `/linked` as `node_modules/@graft/cloud-backings`,
# the shape the runtime copies over `/app`. Under `node_modules` because that is where the bundle's
# `import()` of the bare name looks and where the package's own third-party imports already resolve;
# a real directory rather than pnpm's link because the hoisted install below puts workspace links in
# `apps/server/node_modules`, not the root, and the runtime copies neither that directory nor the
# source tree they point at (measured on the `prod-deps` stage, GRA-38). Staged rather than copied
# straight from the tree so the runtime has one path to copy whether the package is present or not —
# a `COPY` of a path that may not exist cannot be written. The condition is the directory and not
# `dist/`, so a linked package that produced no build fails here, at `cp`, and not at the first
# `GRAFT_BACKINGS=cloud` boot with a sentence about the package not being installed.
FROM deps AS build
COPY . .
RUN pnpm --filter @graft/web build \
 && pnpm --filter @graft/ask-card build \
 && pnpm --filter @graft/server build \
 && pnpm --filter @graft/cloud-backings build \
 && mkdir -p /linked \
 && if [ -d packages/cloud-backings ]; then \
      mkdir -p /linked/node_modules/@graft/cloud-backings \
      && cp -r packages/cloud-backings/dist packages/cloud-backings/package.json \
           /linked/node_modules/@graft/cloud-backings/; \
    fi

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
# The linked backings package, built, as `node_modules/@graft/cloud-backings` — or nothing, when the
# `build` stage found no package to stage (the comment on that stage). Its third-party dependencies
# are already in the layer above: `prod-deps` installs from a lockfile that names them whenever the
# package is in the tree it was given.
COPY --from=build --chown=graft:graft /linked/ ./
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
