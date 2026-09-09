# syntax=docker/dockerfile:1

# The one image every sandbox and every install step runs from (ADR 0013).
#
# Debian slim rather than Alpine for one reason that matters to the seam: GNU coreutils' `timeout`
# kills the whole process group it started, so an exec's deadline ends `sh -c "a && b"` and every
# grandchild with it, and the exec's output stream closes on time. Busybox's `timeout` signals its
# direct child alone, which is the shape Cando's disk sandbox found hanging its pipes.
FROM node:24-slim

ARG SANDBOX_UID=10001

# One RUN so the deletions land in the same layer as what they delete; a later layer removing a file
# leaves it in the image's history, reachable by anyone with the image.
RUN set -eux; \
    groupadd --gid "${SANDBOX_UID}" graft; \
    useradd --uid "${SANDBOX_UID}" --gid graft --create-home --shell /bin/sh graft; \
    # npm moves behind a directory only root can enter. The install step runs as root with this
    # directory on its PATH and is the one process that may resolve packages (ADR 0013); a tool run
    # is the sandbox user, cannot traverse /opt/graft, and finds no npm, npx, corepack or yarn.
    mkdir -p /opt/graft/npm/bin; \
    mv /usr/local/lib/node_modules/npm /opt/graft/npm/lib; \
    ln -s /opt/graft/npm/lib/bin/npm-cli.js /opt/graft/npm/bin/npm; \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh; \
    rm -rf /usr/local/lib/node_modules/corepack /opt/yarn-v*; \
    chmod 700 /opt/graft; \
    # The system package manager goes entirely: nothing installs after this line, in any process.
    rm -rf /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
           /usr/bin/apt-mark /usr/lib/apt /var/lib/apt /var/cache/apt /etc/apt \
           /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-split \
           /usr/bin/dpkg-trigger /usr/bin/dpkg-divert /usr/bin/dpkg-statoverride \
           /usr/bin/dpkg-maintscript-helper /usr/bin/dpkg-realpath /usr/lib/dpkg /var/lib/dpkg; \
    # Directories the backing writes into, owned by the sandbox user. /tools matters most: a fresh
    # named volume mounted there takes this directory's ownership, which is what lets the sandbox
    # user write the first file into a new toolbox.
    mkdir -p /tools /workspace /graft /skills /var/lib/graft/processes; \
    chown graft:graft /tools /workspace /graft /skills /var/lib/graft/processes

# The backing runs each sandbox as this user; only its own setup execs and the install container
# run as root. The default command only keeps the container alive: work arrives as execs.
USER graft
WORKDIR /workspace
ENV HOME=/home/graft
ENTRYPOINT []
CMD ["sleep", "infinity"]
