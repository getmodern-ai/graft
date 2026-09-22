---
status: accepted
---

# Packages install at publish or never

An authored tool that uses an SDK (ADR 0010) needs npm, and npm is the one egress a sandbox would
need beyond the proxy. Graft removes the need at run time: **packages resolve only while `acquire`
is publishing, in a separate install step that alone may reach the registry, and the published
version directory carries its own `node_modules`**, with exact pinned versions, install scripts
disabled, and a lockfile per version. **A run has exactly one egress, the proxy**, in both
deployment forms.

A package may be installed only if it clears the **package policy**: it is on the allowlist of
official vendor SDKs, or it carries npm provenance attestation and clears an age and download
threshold. A package that fails the policy is not a blocked tool, only a blocked shortcut: the
authoring model falls back to hand-written calls through `ctx.fetch`, which it can always do. The
allowlist grows from real `acquire` runs through a review queue.

The hosted form will add a **curated mirror** of the allowlist so the hosted sandbox never touches
the public registry. Roadmap.

## Considered options

- **Open npm at run time.** Rejected: every run a fresh supply-chain exposure with the model
  choosing the package name.
- **No packages at all.** Rejected as an absolute for the reasons in ADR 0010; kept as the
  default the skill teaches.
- **Vendoring without a policy.** Rejected: the model is the weakest link in package selection,
  and a typosquat vendored at publish is a typosquat that runs forever.

## Consequences and accepted risks

- **The Docker form runs each agent's tools in one container**, found again by name on every run,
  from one prebuilt image, on an internal network whose only route is the proxy container, with the
  toolbox mounted as a volume. Installs happen in a separate build container. Blaxel keeps its firewall ruleset as in Cando.
- **Published versions are larger** by their dependencies. Accepted; a version is content it can
  run without asking anyone.
- **Provenance is a real filter now.** The Google, Slack, Octokit and Linear clients all publish
  npm attestations; a long tail does not, and lands in raw calls.
