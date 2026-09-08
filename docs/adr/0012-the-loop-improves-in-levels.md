---
status: accepted
---

# The loop improves in levels

The Self-Harness paper (arXiv 2606.09498) describes a fixed model improving the harness that
governs its own behaviour through three stages: mine weaknesses from execution traces, propose
minimal edits, accept only edits that regress nothing on held-in and held-out splits. Graft
applies that idea in five levels and decides now which are in the product:

- **L0, inherited from Cando.** Static check and dry run at publish, a test input, the outcome
  stored per version. **In the product at launch.**
- **L1, candidates.** When a dry run fails, `acquire` diagnoses and retries with a changed module
  several times inside one job before giving up. **In the product at launch.**
- **L2, repair.** The per-tool failure rate is watched; when a tool that used to pass starts
  failing, `acquire` re-runs against the failing trace and republishes. **The first feature after
  launch**, once weeks of real failure data exist to tune the trigger. A repaired read-only tool
  keeps its approval; a repaired write tool asks again once (ADR 0008).
- **L3, harness mining.** Across every customer, failed authoring runs are clustered by cause,
  edits to Graft's own skill, prompts and checker rules are proposed, and an edit is accepted only
  if the eval suite does not regress. **Graft's internal practice from the first week**, human
  gated, weekly, never a customer-facing feature.
- **L4, beyond tools.** The outer agent's skills and instructions as surfaces Graft edits.
  **Never.** Hermes creates skills from experience natively; competing there dilutes the bet.

## What must be recorded from day one for L2 and L3 to be possible

Every inner-loop trace of `acquire`, every vendor error body with credentials redacted, every
dry-run report, and the per-tool, per-agent outcome ledger that ADR 0009 also reads. These are
schema decisions in the first release, not features of a later one.

## Considered options

- **L0 and L1 only, everything else undefined.** Rejected: L2 is the strongest line in the pitch
  and L3 is why the product gets better; leaving them undefined is how they never happen.
- **L2 at launch.** Rejected: its trigger cannot be tuned without data, and shipping a repair loop
  that misfires on a flaky vendor would cost more trust than it earns.

## Consequences and accepted risks

- **L3 is a process, and processes decay.** It is a recurring Linear issue with an owner, and its
  eval results are recorded in the repo.
- **ADR 0004 is the precondition.** All of this is reachable only because the authoring traces are
  Graft's.
