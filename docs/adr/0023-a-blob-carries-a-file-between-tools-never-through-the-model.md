---
status: accepted
---

# A blob carries a file between tools, never through the model

A **blob** is a file one tool writes for another to read, held for the agent that wrote it for 24
hours and never shown to the model. The ref on the wire, `blob://<id>`, is the whole of what a
model, a harness or a person sees of it. A module writes one with `ctx.blob.write`, reads one with
`ctx.blob.read`, and the ref travels as a plain string in a tool's result and the next tool's
input. Decided with Aleks on 2026-09-22 (GRA-181).

## Why a ref, and why now

A tool is one call against one connection: the capability token names one connection, so a tool
that downloads from Gmail and uploads to Slack cannot exist. A workflow across two vendors is two
tools, and the only thing that could pass between them was the tool result, which the model reads,
which is text, and which is bounded at 64,000 characters. A 24 MB attachment cannot cross that gap
at all, and a 40 KB one crosses it as base64 the model pays tokens for and has no use for. The
blob is the second channel: a ref the model carries, bytes it never sees.

Three facts found on the way changed what the work is. The check refused three modules
(`child_process`, `net`, `dgram`) and waved every other Node built-in through, `fs` included. The
sandbox is one long-lived container per agent, found by name on every run and never destroyed;
the seam dropped Cando's expiry on purpose. The toolbox volume is read-write and shared by every
agent of the person. So a module could already write a file in one run and read it from another
agent's run, ungoverned. This decision is not loosening a guardrail; it is putting one where there
was none.

## Where a blob lives, and what enforces the scope

A blob is a directory under the agent's own path on the toolbox volume in the self-hosted form and
on the Agent Drive in the hosted form: `.blobs/<agentId>/<id>/` holding `data` and a `meta.json`
sidecar (bytes, content type, name, written at, the tool version, the expiry), each landed by
write-then-rename so a reader sees a whole blob or none. The sandbox has no route to the database;
the server learns of a blob from the ledger the runner returns beside the result, and writes one
`blob` row per file. Scope is enforced the way `ctx.fetch`'s is: the check bans the filesystem
modules so `ctx.blob` is the only route, and the runner refuses a ref outside this agent's
directory. The door refuses a dead ref before a sandbox is touched: `blob_not_found` (missing, or
another agent's, never saying whose), `blob_expired`, `blob_quota`.

## Considered options

- **A. The agent's sandbox, under `/tmp`.** Scoped by construction, since the sandbox is the
  agent's, with nothing to check. Rejected as the default: the hosted sandbox's own filesystem is
  not the durable layer, the server cannot see or sweep it without exec'ing in, and a container
  recreate loses it. Kept as the hosted fallback if the drive proves too slow (GRA-184).
- **B. A directory per blob on the toolbox volume and the Agent Drive**, governed by the check and
  the runner. Chosen: durable in both forms, visible to the server through the toolbox store it
  already has, and the ref is opaque so C can replace it without a module noticing.
- **C. A server-side blob seam** (a directory in the open form, an object store in the hosted),
  reached from the sandbox through the proxy under the capability token. The strongest
  governance, since the server enforces agent, TTL and size and no module can bypass it. Deferred:
  bytes would cross the proxy on every write and read, and Graft's own route would need streaming.
  This is the later shape.

## Consequences and accepted risks

- **The check bans `fs`, `fs/promises`, `worker_threads`, `vm`, `module`, `cluster` and
  `inspector`** beside the three it refused. Published versions are not re-checked; nothing running
  breaks. A vendored SDK's own `fs` use is outside the scan, as it was.
- **Scope is the agent.** A person's Claude agent cannot hand a blob to their Hermes agent.
  Widening to the person is a one-line change in the path and the row, deliberately not made.
- **24 hours**, a constant, so a blob survives a first-write approval left overnight: a pending
  action lives 24 hours (ADR 0008) and a shorter TTL would fail exactly the workflow with a human
  step in it.
- **Writing a blob never asks.** ADR 0008's grain is about vendor side effects; a blob is Graft's
  own scratch, scoped and swept by rule. Annotations derive from vendor methods as before, so a
  Gmail download tool that writes a blob stays read-only.
- **Limits are constants**: 256 MiB per blob, 1 GiB live per agent. Knobs when someone hits them.
- **The sweep deletes.** The toolbox's rule that nothing under `tools/` is ever removed (ADR 0009)
  stands; a blob past its time is the one thing the system deletes, on the working-set sweep's
  timer, and its row stays with `removed_at` so the door can say expired rather than not found. A
  run killed after a write leaves a directory with a sidecar and no row; the sweep adopts it or
  removes it past the TTL.
- **The `blob:` scheme is also the browser's object-URL scheme.** Nothing of Graft's runs a ref
  through a browser, and the console shows a ref as text if it ever shows one. Noted so nobody
  treats the collision as a bug.
- **The proxy's cap is unchanged by default.** A 24 MB Gmail attachment stays blocked on a
  self-host at 10 MiB until the operator raises `GRAFT_PROXY_MAX_BODY_BYTES` (ADR 0010 as amended
  2026-09-22). Graft Cloud raises it to run the proof.
- **A person or a harness reaching a blob is deferred.** No console download, no MCP
  `resource_link`. A ref means something to a tool and nothing else; the roadmap carries the
  condition that brings it forward.
