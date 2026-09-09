# `@graft/sandbox`

The sandbox seam (CONTEXT.md, "Sandbox"): the interface the core talks to when authored code has to
run somewhere, the in-process fake for unit tests, and the conformance suite every backing passes.

ADR 0002 gives the seam exactly two backings. `@graft/sandbox-docker` in this repository is one; the
hosted backing is a private package (GRA-20). Nothing in this package is shaped like either.

## The verbs

`SandboxBackend`, what exists before there is a sandbox:

| Verb | Does |
| --- | --- |
| `ensure({ name, memoryMb? })` | Find the sandbox by name or create it; `existed` tells which |
| `destroy(name)` | Remove it; the toolbox it mounted is untouched; an unknown name is not an error |
| `list()` | Every sandbox this backing has and has not destroyed |
| `install({ toolboxId, versionPath, timeoutSeconds? })` | ADR 0013's build step: resolve a version directory's packages into it, scripts disabled, lockfile left behind. The one verb that may reach the registry, in its own sandbox |

`SandboxHandle`, one sandbox:

| Verb | Does |
| --- | --- |
| `writeTree(files, destination)` | Write files under a directory, creating what is missing |
| `exec(command, { workingDir?, timeoutSeconds?, env? })` | Run through `sh`, wait, return combined output trimmed. `env` is this process's alone |
| `execDetached(command, { name, workingDir?, env?, timeoutSeconds? })` | Start and return the name |
| `waitForProcess(name, { maxWaitSeconds, pollIntervalMs? })` | Poll by name; `running` with `exitCode: null` when the wait runs out |
| `mountToolbox({ toolboxId, mountPath })` | Make the toolbox visible at a path; idempotent. Mount before writing anything else |
| `downloadDirectory(path)` | Every file under a directory, paths relative, sorted; `writeTree`'s shape |
| `ls(path)` | Direct entries as absolute paths, sorted |
| `read(path)` | Whole file as text |

`src/types.ts` carries the reasoning per verb and what changed from Cando's seam (ADR 0011).

## The conformance suite

```ts
import { sandboxConformance } from "@graft/sandbox/conformance";

sandboxConformance("my backing", async () => ({
  backend: createMyBackend(),
  proxyUrl: "http://proxy:8080/", // where the proxy stub answers, as a sandbox sees it
  close: async () => {},
}));
```

A backing's test file is that call and nothing else; the assertions live in `src/conformance.ts` so
both backings answer the same questions. A fixture with `noNetwork: true` (the fake) has the egress
assertions marked not applicable rather than run.

## The fake

`createFakeSandboxBackend()` is a temporary directory: each sandbox is a subdirectory, each toolbox
another, a mount is a symlink, and a command runs through `sh` with a clean environment and its
sandbox paths mapped under the root. It refuses a command naming anything real outside the root or a
program the sandbox image does not carry. That guard is against accidents, not adversaries; the fake
is not a boundary and nothing in production relies on it. `install` is a no-op there.
