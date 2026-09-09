# `@graft/sandbox-docker`

The Docker backing of the sandbox seam (`@graft/sandbox`): the self-hosted form's sandbox, and the
one that runs in CI (ADR 0002, ADR 0013).

## Shape

- **One image**, built from this package's `Dockerfile`: Node 24 on Debian slim, a non-root user
  `graft` (uid 10001), and no package manager a tool run can reach. `npm` is kept behind a directory
  only root can enter, for the install step alone; `npx`, `corepack`, `yarn`, `apt` and `dpkg` are
  removed outright. `pnpm run image:build` in this package produces `graft-sandbox:dev`.
- **One container per sandbox**, created by `ensure` from that image on the internal network named
  in the options, kept alive by `sleep infinity` under `docker-init`, and worked through execs. The
  container runs as `graft`; the backing's own setup steps (creating a directory for `writeTree`)
  exec as root, a tool run never does. Capabilities are dropped to the three those setup steps need,
  a pid limit is set, and `no-new-privileges` is on.
- **`exec`** is an exec on that container: `timeout -s KILL <seconds> sh -c <command>`, with the
  per-exec environment on the exec request and nowhere else, so it is that process's alone. GNU
  `timeout` kills the whole process group, which is why the base is Debian rather than Alpine.
- **`execDetached`** is a background process whose stdout, stderr, exit code and pid are files under
  `/var/lib/graft/processes/<name>/`; `waitForProcess` reads them by name, from any handle to the
  sandbox, in one exec per poll. A name is unique per sandbox lifetime; reusing one replaces the
  record. Exit code 137 (killed by `timeout`) reads as `killed`.
- **`writeTree`** and **`downloadDirectory`** ride the archive endpoints as tar streams — `docker cp`
  without the CLI — with every directory entry owned by the sandbox user, so what the backing writes
  the tool can write beside.
- **`mountToolbox`** mounts the named volume `<toolboxVolumePrefix>-<toolboxId>` at the path. A
  running container cannot take a new mount, so the sandbox is recreated around it — same name, same
  network, every toolbox it had plus this one. Only the volumes survive: mount before writing anything
  else. Mounting the same toolbox at the same path again is a no-op. The image owns `/tools` as
  `graft`, so a fresh volume mounted there is writable from the first file.
- **`install`** is its own container from the same image on the install network (default: the
  daemon's `bridge`), as root, with `npm` on its path: `npm ci` when the version directory has a
  lockfile, `npm install --save-exact` when it does not, scripts disabled both ways, registry from the
  options, everything handed back to the sandbox user at the end. The answer is a process result, so a
  refused or missing package is a diagnostic the caller reads, not an exception.
- **`destroy`** removes the container. Volumes are never removed by the backing outside tests.
- **`list`** filters containers by the label `graft.sandbox.prefix=<prefix>`, so two backings on one
  daemon see only their own.

## Talking to Docker

The backing speaks the Engine API (`v1.43`, Docker 24 and later) over `node:http` — raw HTTP rather
than a client library, because the surface used is a dozen endpoints and the one hard part,
demultiplexing an exec's stream, is the same eight-byte frame header whichever client reads it.
`DOCKER_HOST` is read as the CLI reads it: `unix:///path` (default `/var/run/docker.sock`) or
`tcp://host:port`. TLS is refused rather than half-supported.

## Two arrangements, for the compose file (GRA-33)

The server creates sandboxes; the proxy is what they talk to. Both arrangements below leave every
sandbox on an internal network whose only other member is the proxy.

**1. Mounted socket.** The server container mounts the host's Docker socket and creates sandbox
containers as siblings of itself on the host's daemon.

```yaml
services:
  graft:
    image: graft
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [default, sandbox]      # `sandbox` so the proxy inside the server is reachable
    environment:
      GRAFT_SANDBOX_IMAGE: graft-sandbox
      GRAFT_SANDBOX_NETWORK: graft_sandbox   # compose prefixes network names with the project
networks:
  sandbox:
    internal: true
```

The sandbox network must exist before the first `ensure`, and must be `internal: true`; the backing
inspects it once and refuses otherwise. Whoever runs the proxy joins that network under a stable name
or alias (`proxy` in the suite), and `PROXY_PUBLIC_URL` handed to a sandbox names that alias, since a
sandbox resolves container names through the daemon's DNS and nothing else — an internal network
gets no gateway and no forwarding of external names, which is what the egress assertions in the
conformance suite check. The socket mount hands the server root-equivalent access to the host; that
is the operational surface ADR 0002 accepts, and the reason the server should run as a dedicated user
on a dedicated host.

**2. Sibling daemon.** The server talks to a Docker daemon in another container (`docker:dind`, or a
rootless daemon) over TCP.

```yaml
services:
  graft:
    environment:
      DOCKER_HOST: tcp://docker:2375
  docker:
    image: docker:dind
    privileged: true
    command: ["--host=tcp://0.0.0.0:2375", "--tls=false"]
```

Everything then lives inside the sibling daemon: the sandbox network, the volumes, the image. The
image has to be built or loaded *there* (`docker -H tcp://docker:2375 build …`), and the proxy has to
be reachable from a network inside that daemon, which in practice means the proxy runs as a
container on it too. Plain TCP only, on a network no one else can reach; the backing refuses
`https://`.

In both arrangements the toolbox volumes belong to the daemon, not to the server container: a server
restart keeps every toolbox, and a `docker volume prune` is what would lose them.

## The install network

Default `bridge`: the install container reaches the internet, and `--ignore-scripts` plus the
registry setting are what keep npm the only network client. A deployment that wants the registry
alone, or ADR 0013's curated mirror when it exists (GRA-9), sets `install.network` to a network whose
one way out is that mirror and `install.registry` to its URL. The backing enforces only that the
install network is not the sandbox network.

## Tests

`src/docker.test.ts` runs the conformance suite from `@graft/sandbox` against this backing and then
the Docker-specific cases: image hygiene, a real install of `left-pad`, the network guard. Without a
daemon it prints `skipped: no Docker` and passes; under `CI` it fails instead. `GRAFT_SANDBOX_IMAGE`
names the image to test; unset, `graft-sandbox:dev` is built from the `Dockerfile` when missing. The
fixture creates an internal network, a proxy stub container (Node's `http` module answering 200 on
`:8080` under the alias `proxy`) and a backend whose prefix is unique to the run, and removes all
three afterwards.
