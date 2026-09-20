---
status: superseded by ADR 0022
---

# AGPL core, MIT skill, one copyright holder

The core server that the Docker image runs is licensed **AGPL-3.0**. The thin skill and any plugin
a person installs into their harness are **MIT**. The hosted backings are private (ADR 0002).
**The company is the sole copyright holder**, with contributor agreements from the first outside
contribution, so it can grant itself a commercial licence for Cando's later dependency (ADR 0011)
and so the licence can be changed later if it has to be.

The moat is not the server code. It is the hosted authoring model, the eval suite, the mined
improvements to the skill (ADR 0012) and the package allowlist (ADR 0013), all private. AGPL only
ensures the loop itself cannot become a competitor's hosted feature for free, and it costs
self-hosters nothing.

**This decision is provisional.** Community pushback against AGPL is expected in this audience and
is watched for in the first months.

## Considered options

- **MIT for everything open**, as executor.sh does. Rejected for now: nothing would stop a hosted
  competitor, executor.sh included, lifting the loop into their product.
- **Source-available (FSL or BSL) converting to Apache after a delay.** Rejected: this audience
  does not count it as open source. Kept as the fallback if the enterprise objection ever matters
  more than the community one.

## Consequences and accepted risks

- **The order of operations is the safety.** Loosening from AGPL to a permissive licence is a door
  that can be opened in an afternoon while the copyright is in one place; the reverse is impossible
  once a permissive version has shipped. Starting strict and watching is the reversible choice.
- **Enterprises avoid AGPL.** They are not the target, and the hosted tier serves them without
  touching the licence.
- **Cando is a proprietary service depending on an AGPL core.** Covered by the internal commercial
  grant that single ownership makes ordinary. The contributor agreement is what keeps that grant
  clean.

## Amendment 2026-09-21: superseded by ADR 0022, the core is Apache-2.0 and the CLA is a DCO

**Decided by Aleks on 2026-09-21**, before the repository was made public. The review this record
asked for has happened, and it went against the record. Section 13 of the AGPL obliges an operator
who *modifies* the program to publish those modifications; a competitor running the image as it is,
with their own backings behind ADR 0002's seams, modifies nothing and publishes nothing. So the
copyleft was protecting the server code, which the second paragraph above already says is not the
moat, and the moat it does name is private by absence. The CLA went with it: Cando's dependency
(ADR 0011) needs no commercial grant from a permissive core, and the CLA was the part of this
arrangement the audience objected to. **ADR 0022 is the decision from here**; the body above stays
as the record of what was decided on the evidence of the time.
