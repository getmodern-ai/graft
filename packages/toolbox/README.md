# `@graft/toolbox`

The toolbox storage seam (CONTEXT.md, "Toolbox"; ADR 0002) and the backing this repository holds: a
person's authored tools as a directory tree.

## The seam

`ToolboxStore` — `readTree`, `writeTree`, `read`, `list`, `exists`, `remove` — over a toolbox id and a
path relative to that toolbox. `remove` accepts a draft and nothing else: nothing under `tools/` is
ever deleted (ADR 0009), and the store is where that is enforced rather than trusted.
`ToolboxMirror` — `mirrorVersion(toolboxId, versionPath)` — is the off-site copy the hosted form makes
after a publish, asynchronous and best-effort; the mirror here records the call and copies nothing,
and the S3 mirror is the private package's (GRA-20). Neither interface names a bucket, a volume or a
region.

## The layout

```
<root>/<toolboxId>/
  tools/<vendor>/<name>/v<N>/     a published version: the module, and when it declares packages,
                                  its own node_modules and package-lock.json (ADR 0013)
  .drafts/<jobId>/                what an acquire job writes before it publishes
```

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
  with a mounted socket the compose file (GRA-33) mounts the same host directory into the server
  container at the same path; with a sibling daemon the option has no meaning and the toolbox would
  have to reach the server another way.
- **In the hosted form**, the filesystem store on the server plus the S3 mirror; the Blaxel sandbox
  mounts its own copy (GRA-20).

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
