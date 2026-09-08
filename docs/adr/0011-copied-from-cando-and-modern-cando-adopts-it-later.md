---
status: accepted
---

# Graft is copied from Cando and Modern, and Cando adopts it later

Graft starts as **a new repository seeded by copying** Cando's authored-tools framework: the proxy
package, the capability token, the credential vault behind a keyring seam, the static checker, the
runner, the dry run, the authoring skill and the eval scenarios. Into that it folds two pieces
from Modern that Cando lacks: **multi-host forwarding** in the proxy and the **SDK-rebinding
recipe** with its generator skill (ADR 0010).

**Neither Cando nor Modern is a live dependency in either direction while the tenancy model is
being reshaped** (ADR 0007, ADR 0008). Cando keeps its copy untouched. **Once Graft's core has a
stable API, Cando replaces its copy with Graft as a dependency and becomes customer one.** That is
also the moment Cando's own spec's "spin-out boundary" gets tested for real.

## Considered options

- **Extract from Cando in place, Cando depending on the new packages from day one.** Rejected: a
  product bet tied to a shipping product's release train, with every schema change landing in
  both.
- **Fork and never reconverge.** Rejected: two copies of a credential proxy drifting apart is the
  worst outcome for both.
- **Seed from Modern instead.** Rejected: its forty pre-built integrations are the catalog model
  ADR 0001 declines, and its stack is older. Its proxy and SDK skill are the pieces worth taking.

## Consequences and accepted risks

- **Cando carries an explicit debt**: adopt Graft when stable. Recorded here and in Cando's own
  ADRs when the adoption happens, so it is a commitment with a date rather than an intention.
- **Copied code must be re-read, not trusted.** Cando's comments name Cando tickets and Cando
  decisions; each copied file gets its comments repointed at Graft's ADRs in the same PR that
  copies it.
- **Licensing follows** (ADR 0015): the copy is made under the company's ownership of both
  codebases, and Cando's later dependency on an AGPL core is covered by an internal commercial
  grant.
