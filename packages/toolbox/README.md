# `@graft/toolbox`

The toolbox storage seam (CONTEXT.md, "Toolbox"; ADR 0002) and the backing this repository holds: a
person's authored tools as a directory tree. Beside it, the blob store seam (CONTEXT.md, "Blob
store"; ADR 0023): an agent's blobs between the tool that wrote one and the tool that reads it.

## The seams

`ToolboxStore` — `readTree`, `writeTree`, `read`, `list`, `exists`, `remove` — over a toolbox id and a
path relative to that toolbox. `remove` accepts a draft and nothing else: nothing under `tools/` is
ever deleted (ADR 0009), and the store is where that is enforced rather than trusted.
`ToolboxMirror` — `mirrorVersion(toolboxId, versionPath)` — is the off-site copy the hosted form makes
after a publish, asynchronous and best-effort; the mirror here records the call and copies nothing,
and the S3 mirror is the private package's (GRA-20). Neither interface names a bucket, a volume or a
region.

`BlobStore` (`listAgents()`, `list(agentId)`, `readMeta(agentId, blobId)`, `exists(agentId, blobId)`,
`remove(agentId, name)`, `stat(agentId, name)`) is keyed by agent, reads and removes only, and is the
seam a blob past its time is deleted through (GRA-189); a blob is written by the runner from inside
the sandbox (GRA-186), never by the server. `listAgents` answers the agent ids with a directory under
`.blobs/`, sorted, skipping a symlink or a name that is not an agent id: the store's half of the
sweep's roster, so an agent that was revoked or deleted still has its directories judged (GRA-195).
`remove` and `stat` take a blob id or a `<blobId>.tmp`
and refuse anything else; `stat` answers when the directory was last written (the newest of its own,
`data`'s and `meta.json`'s modification times) and how many bytes `data` holds, which is how the
sweep tells a write still landing from one a killed run abandoned. `readMeta` answers `null` for a
blob or a sidecar confirmed absent and rejects for anything else (a symlink, a permission, a backing
error), so a caller never reads a failed read as a missing file. The
backing here is `createFilesystemBlobStore`, over the same root as the toolbox store; the hosted
form's is the private package's (GRA-192), and `blobStoreConformance` is the suite both run.

## The layout

```
<root>/
  <toolboxId>/
    tools/<vendor>/<name>/v<N>/     a published version: the module, and when it declares packages,
                                    its own node_modules and package-lock.json (ADR 0013)
    .drafts/<jobId>/                what an acquire job writes before it publishes
  .blobs/<agentId>/
    <blobId>/                       one blob (ADR 0023): its `data` and its `meta.json` sidecar (bytes,
                                    contentType, name, writtenAt, expiresAt, agentId, toolVersion), written
                                    by the runner (GRA-186), removed by the sweep once expired (GRA-189)
    <blobId>.tmp/                   the same blob while it is still being written, renamed whole
```

The blobs are beside the toolboxes, not inside one: a toolbox is the person's and every agent of the
person mounts it, a blob is the agent's alone. **The scope is a mount** (ADR 0023): an agent's sandbox
mounts `.blobs/<agentId>` and nothing above it at `/blobs`, the way it mounts the person's toolbox at
`/tools` (`MountToolboxArgs.blobs` on the sandbox seam), so another agent's blobs are on no path it
can name, whatever a vendored dependency does with `fs`. `blobSandboxPath(blobId)` is `/blobs/<blobId>`,
with no agent id in it. No toolbox can be called `.blobs`, since a toolbox id starts with a letter or
digit, which is what keeps the two trees apart under one root.

One toolbox per person; the toolbox id is the person's id (`toolboxIdOf`), which is also the name of
the volume a sandbox mounts. `tool_version.path` holds `tools/<vendor>/<name>/v<N>` exactly as
`versionPath` returns it; inside a sandbox the toolbox is mounted at `/tools`, so the same directory
is `sandboxPath(version.path)` — `/tools/tools/<vendor>/<name>/v<N>`. A republish writes `v<N+1>`
beside `v<N>`.

## How the store and a sandbox meet

The server holds the toolbox as files through this store; a sandbox sees the same toolbox as a mount.
The two are one tree in each place the code runs:

- **In a service test**, the fake sandbox backing keeps toolboxes under `<fake.root>/toolboxes/<id>`
  and mounts one with a symlink; the store is rooted at `<fake.root>/toolboxes`.
- **In the self-hosted form**, the Docker backing mounts a named volume per toolbox id. Given its
  `toolboxHostRoot` option — the same directory as `GRAFT_TOOLBOX_ROOT` — every toolbox volume is a
  bind of `<root>/<toolboxId>`, so the version the publish wrote through the store is what the
  install step installs into and what a run mounts. The bind's path is read by the Docker daemon, so
  it holds for a server running on the host. The compose file (GRA-33), where the server is itself a
  container, uses the backing's other option instead: `toolboxVolume` (`GRAFT_TOOLBOX_VOLUME`), one
  named volume holding every toolbox as a subdirectory, mounted whole into the server at
  `GRAFT_TOOLBOX_ROOT` and into each sandbox by its own subpath — the same tree, and a sandbox still
  sees only its own toolbox (`packages/sandbox-docker/README.md`). With a sibling daemon neither
  option has meaning and the toolbox would have to reach the server another way.
- **In the hosted form**, the store is the cloud backings' own (GRA-39, in the private package): it
  writes onto the Agent Drive each toolbox is — the same drive the install step and every run mount —
  through a sandbox of its own, so the server holds no toolbox directory at all, and the selector
  takes that store in place of the filesystem one (`apps/server/src/backings.ts`). The S3 mirror is
  the best-effort copy beside it (GRA-20).

Ownership follows: the server's user owns what the server writes, the sandbox user (`graft`, 10001)
owns what a sandbox or the install step writes, and both are world-readable. The server can remove a
draft a sandbox wrote only where its user may write those directories — the self-hosted image runs the
server as that user (GRA-33).

## Configuration

`GRAFT_TOOLBOX_ROOT` (`@graft/env`), default `./.graft/toolboxes` — relative paths resolve against the
server's working directory. The directory is created on the first write.

## Tests

`src/conformance.ts` is the suite every backing of the store runs; `src/filesystem.test.ts` runs it
against the filesystem backing and adds what is true of a directory alone, including that the fake
sandbox and the store see one tree.
