# GRA-4 final report (sandbox seam, Docker backing, conformance suite), merged as PR #5 (main e21ccc7)

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Paths are repo-relative on `main`.

## Decisions taken

| Decision | Choice | Why |
| --- | --- | --- |
| Docker client | Raw Engine API (`v1.43`) over `node:http`; `DOCKER_HOST` parsed as the CLI does (`unix://`, `tcp://`; TLS/ssh refused); `tar-stream` for archive endpoints; no `dockerode`. | A dozen endpoints; demuxing the 8-byte-framed exec stream is the same either way; dockerode drags ssh2, tar-fs, typings. Same code via mounted socket or TCP sibling. |
| Image base | `node:24-slim` (Debian 12), user `graft` uid/gid 10001, `WORKDIR /workspace`, `sleep infinity` under `docker-init`. | GNU `timeout -s KILL` kills the whole process group so an exec's deadline ends grandchildren; busybox does not. |
| No package manager reachable | `npm` moved to `/opt/graft/npm` (root-only, 700) for the install step; `npx`, `corepack`, `yarn`, `docker-entrypoint.sh`, `apt*`, `dpkg*`, `/var/lib/{apt,dpkg}`, `/etc/apt` removed in the same layer. | Acceptance criterion; same `RUN` so nothing survives in layer history. |
| Network restriction | Sandbox containers get `NetworkMode: <network>`; the network must exist and be `Internal: true`, inspected once and refused otherwise. Internal networks have no gateway (external IP → ENETUNREACH) and no external DNS (hostname → EAI_AGAIN). The proxy is reached by container name/alias via the daemon's embedded DNS. | ADR 0013 boundary; a misconfigured compose fails at first `ensure` rather than leaking. |
| Install egress | Separate root container from the same image, `PATH` including `/opt/graft/npm/bin`, on `install.network` (default `bridge`); `npm ci` if lockfile else `npm install --save-exact`; `--ignore-scripts` on command and env; `chown -R 10001:10001` at the end. Refuses `install.network === sandbox network`. | "Registry only" is npm behaviour plus configured registry, not a network rule; a hard rule = point `install.network` at a mirror-only network (GRA-9). |
| Detached processes | Files under `/var/lib/graft/processes/<name>/{stdout,stderr,code,pid}`; start script backgrounds `timeout -s KILL <s> sh -c <cmd>`, writes `code` via rename, returns once `pid` exists. `waitForProcess` polls with one exec whose first line is `NONE`/`RUNNING`/`LOST`/`EXITED <n>`. Exit 137 → `killed`. Works from any handle incl. a later `ensure`. | Docker discards detached exec output and has no exec-kill API. |
| `mountToolbox` | Named volume `<toolboxVolumePrefix>-<toolboxId>`; running containers cannot take a mount, so the sandbox is recreated with the union of mounts (same name/network/memory). Idempotent. Image owns `/tools` as `graft`. | One way to mount. Cost: **mount first**; only volumes survive recreation. |
| Hardening | `Init: true`, `PidsLimit: 512`, `CapDrop: ALL` + `CapAdd: CHOWN, DAC_OVERRIDE, FOWNER`, `no-new-privileges:true`. | The three caps serve the backing's own root setup execs; a tool run as `graft` has none. |
| Names/labels | Containers `<prefix>-<name>`, labels `graft.sandbox.prefix`, `graft.sandbox.name`; `list` filters by prefix; `SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`. | Two backings on one daemon see only their own. |
| Dropped from Cando's seam | `setExpiry`, `ensureDrive`; `mountDrive` → `mountToolbox`; `deleteSandbox` → `destroy`; `install` added; status loses `"stopped"`; `stdout`/`stderr` required on results. | Recorded in the header of `packages/sandbox/src/types.ts`. |

## Interfaces (`packages/sandbox/src/types.ts`)

```ts
export type SandboxFile = { path: string; content: string };
export type SandboxProcessStatus = "running" | "completed" | "failed" | "killed";
export type SandboxProcessResult = { status: SandboxProcessStatus; exitCode: number | null; logs: string; stdout: string; stderr: string };
export type ExecOptions = { workingDir?: string; timeoutSeconds?: number /* 30 */; env?: Record<string, string> };
export type ExecDetachedOptions = { name: string; workingDir?: string; env?: Record<string, string>; timeoutSeconds?: number /* 600 */ };
export type WaitForProcessOptions = { maxWaitSeconds: number; pollIntervalMs?: number /* 1000 */ };
export type MountToolboxArgs = { toolboxId: string; mountPath: string /* absolute */ };

export type SandboxHandle = {
  writeTree(files: SandboxFile[], destination: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<string>;              // combined output, trimmed
  execDetached(command: string, options: ExecDetachedOptions): Promise<string>; // returns the name
  waitForProcess(name: string, options: WaitForProcessOptions): Promise<SandboxProcessResult>;
  mountToolbox(args: MountToolboxArgs): Promise<void>;                          // idempotent; MOUNT FIRST
  downloadDirectory(path: string): Promise<SandboxFile[]>;                      // relative paths, sorted
  ls(path: string): Promise<string[]>;                                          // absolute paths, sorted
  read(path: string): Promise<string>;
};

export type EnsureSandboxArgs = { name: string; memoryMb?: number };
export type InstallArgs = { toolboxId: string; versionPath: string /* relative to toolbox root */; timeoutSeconds?: number /* 600 */ };
export type SandboxSummary = { name: string; createdAt: string | null };

export type SandboxBackend = {
  ensure(args: EnsureSandboxArgs): Promise<{ handle: SandboxHandle; existed: boolean }>;
  destroy(name: string): Promise<void>;
  list(): Promise<SandboxSummary[]>;
  install(args: InstallArgs): Promise<SandboxProcessResult>;  // failure is an answer, not an exception
};
```

Exports: `@graft/sandbox` (all of the above + `createFakeSandboxBackend`), `@graft/sandbox/types`, `@graft/sandbox/fake`, `@graft/sandbox/conformance`.

**Fake:** `createFakeSandboxBackend(): FakeSandboxBackend` = `SandboxBackend & { root; sandboxRoot(name); toolboxRoot(toolboxId); close() }`. Temp dir; mount = symlink; commands via `sh` with env `{PATH, HOME, ...env}`; roots `/tools /graft /skills /workspace /tmp /home` rewritten under the root; guard refuses host paths, `..`, and package managers/fetchers. `install` is a no-op returning `completed`.

**Docker (`packages/sandbox-docker/src/backend.ts`):**
```ts
createDockerSandboxBackend({
  image: string; network: string; dockerHost?: string; prefix?: string /* "graft-sandbox" */;
  toolboxVolumePrefix?: string /* "graft-toolbox" */;
  install?: { network?: string /* "bridge" */; registry?: string /* https://registry.npmjs.org/ */ };
}): DockerSandboxBackend // SandboxBackend & { engine; containerName(name); toolboxVolumeName(id); removeToolboxVolumes() }
```
Also exported: `ensureInternalNetwork(engine, name)`, `removeNetwork`, `DockerEngine`, `DockerEngineError`, `resolveDockerHost`, `SANDBOX_USER/UID/GID`.

**`install` contract:** mounts the toolbox volume at `/tools`, `cd /tools/<versionPath>`; exit 66 if the directory is missing, 65 if no `package.json`; `npm ci --ignore-scripts --no-audit --no-fund` when `package-lock.json` exists, else `npm install --ignore-scripts --no-audit --no-fund --save-exact`; chown to the sandbox user; returns `SandboxProcessResult` (`killed` if the host deadline killed the container). Verified with a real `left-pad@1.3.0` install imported offline afterwards.

## Conformance suite (`packages/sandbox/src/conformance.ts`)

`sandboxConformance(name, makeFixture: () => Promise<ConformanceFixture>)`, `ConformanceFixture = { backend; noNetwork?: boolean; proxyUrl?: string; close?() }`. 32 assertions: lifecycle (4), files (4), exec (7), detached (7), toolbox (6), egress (4, skipped as not applicable for `noNetwork`). Docker-specific extras (13) in `packages/sandbox-docker/src/docker.test.ts`, plus 8 pure engine/tar tests.

## Env vars, CI, timings

- Suite reads `DOCKER_HOST`, `CI` (refuses to skip when set), `GRAFT_SANDBOX_IMAGE` (unset → `graft-sandbox:dev`, built if missing); declared under `turbo.json` `test.env`. Without a daemon: `skipped: no Docker (<reason>)` on stderr and passes.
- CI: step `Build the sandbox image` before `Test`, `GRAFT_SANDBOX_IMAGE: graft-sandbox:ci`. Job 1m40s total; image build 16s; Test step 57s. Local: Docker suite 21s, fake 4.5s.
- Catalog additions: `tar-stream ^3.2.1`, `@types/tar-stream ^3.1.4`.

## What GRA-33's compose file must know (`packages/sandbox-docker/README.md`)

1. Declare the sandbox network `internal: true`; compose prefixes it (`<project>_sandbox`), pass the prefixed name. It must exist before the first `ensure`.
2. The proxy must be attached to that network under a stable alias (suite uses `proxy`); `PROXY_PUBLIC_URL` handed to sandboxes uses that alias. If the proxy is mounted inside the server, the server container joins the sandbox network.
3. Arrangement 1: server mounts `/var/run/docker.sock` (root-equivalent to the host, ADR 0002's accepted surface). Arrangement 2: `docker:dind` sibling, `DOCKER_HOST=tcp://docker:2375` on a private network; image, network, volumes and proxy must live inside that daemon.
4. The image must be built/tagged and passed as `image`; the daemon needs `docker-init`.
5. Toolbox volumes `<toolboxVolumePrefix>-<toolboxId>` survive server restarts; only `docker volume prune` removes them; the backing never removes them outside tests.
6. `install.network` defaults to `bridge`; for registry-only egress provide a mirror-only network and set `install.registry`; must differ from the sandbox network.
7. One server instance = one `prefix`.

**Caution for GRA-18/GRA-19:** call `mountToolbox` before `writeTree`/`execDetached` on a Docker sandbox; the mount recreates the container and only volumes survive.
