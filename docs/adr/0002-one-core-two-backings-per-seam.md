---
status: accepted
---

# One core, two backings per seam

Graft is one agnostic core with **exactly two implementations behind each seam**: the sandbox, the
keyring, the toolbox storage, and later the model provider. The self-hosted form runs the core in
Docker with a Docker sandbox, a local keyring and a filesystem toolbox. The hosted form runs the
same core with Blaxel sandboxes, a KMS-backed keyring and S3. **The hosted product ships first**,
because it is the form that produces revenue and the authoring traces ADR 0012 needs; the Docker
image ships beside it because it is also the development environment and the bet's audience
self-hosts.

The commercial parts are hidden **by absence, not by flag**. The open repository contains the core
and the self-hosted backings. The hosted backings, multi-tenant billing and the curated package
mirror live in a private package that implements the same interfaces. There are no runtime flags
in the open code that switch commercial behaviour on.

## Considered options

- **Local-first plugin inside the harness, no server.** Rejected: it makes Graft a component of
  two vendors' release schedules, and it offers no place for the hosted authoring model.
- **Hosted only.** Rejected: the audience chose OpenClaw or Hermes partly to keep credentials on
  their own hardware, and the Docker form is nearly free once the seams exist.
- **A general plugin system so third parties can add backings.** Rejected on executor.sh's own
  evidence: its plugin registry, some 850 lines of optional hooks, never gained a fourth
  implementation and its authors call it "a fiction" they are removing. Two implementations per
  interface is the honest shape.
- **Feature flags in one codebase.** Rejected: flags advertise the shape of what is hidden and rot
  the same way a fake-open registry does.

## Consequences and accepted risks

- **Every seam is a plain interface with two tests**, and a change to the interface lands in both
  backings in the same PR.
- **The Docker form needs the Docker socket or a sibling-container pattern** to launch sandboxes.
  This is an operational surface executor.sh avoided by running model code in an in-process
  QuickJS interpreter; Graft cannot, because authored tools need a filesystem and a route to the
  proxy (ADR 0013).
- **The private package is a second repository to keep in step.** Accepted as the cost of an open
  core that is actually open.
