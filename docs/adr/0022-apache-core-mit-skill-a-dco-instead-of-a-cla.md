---
status: accepted
---

# Apache-2.0 core, MIT skill, a DCO instead of a CLA

The core is **Apache-2.0**. The skill and any harness plugin stay **MIT** (`skills/LICENSE`), and
the hosted backings stay private (ADR 0002). Contributions come in under a **Developer Certificate
of Origin** sign-off and nothing else: inbound equals outbound under Apache-2.0 section 5, so what
a contributor sends arrives under the licence the repository already carries. `CLA.md` and its bot
are gone, and `CONTRIBUTING.md` is what a contributor reads instead.

**This supersedes ADR 0015**, which stays in the tree with an amendment pointing here. Decided by
Aleks on 2026-09-21, before the repository was made public, which is the last moment this costs
nothing.

## The copyleft was not protecting what it was chosen to protect

ADR 0015 chose AGPL because it "ensures the loop itself cannot become a competitor's hosted feature
for free". Section 13 does not do that. What it obliges is an operator who *modifies* the program
and offers it over a network to publish the source of those modifications. A competitor who runs
the image as it is, with their own backings behind the seams ADR 0002 defines, has modified
nothing and publishes nothing. ADR 0002 is what makes that easy, on purpose.

So the copyleft was protecting the server code, and ADR 0015's own second paragraph says the server
code is not the moat. The moat it names is the hosted authoring model, the traces, the mined
improvements to the skill (ADR 0012) and the package allowlist (ADR 0013). Each of those is private
already, by absence rather than by licence. The one item on that list that was not private was the
eval suite: `packages/evals` has been in the open tree since GRA-31.

And a licence stops nobody from reimplementing a loop they can read. The parts that are hard to
copy are the ones a reader cannot see.

## Apache-2.0, and least friction as the deciding criterion

Apache-2.0 is the permissive licence with an express patent grant to its users, and it is the
conventional choice for infrastructure a company wants other companies to run. It is also the
shape the products this audience already trusts have taken: Supabase and PostHog publish a
permissive core and keep the hosted parts to themselves, which is ADR 0002 written as a licence.

The deciding criterion was friction, for the two people Graft needs. A self-hoster's legal review
ends at the licence name. A plugin author sits at the harness boundary, where MIT already applies,
and should never have to work out which side of a copyleft their plugin falls on.

The audience finding points the same way. This audience respects AGPL; what it attacks is AGPL
plus a CLA that lets one party relicense a contribution as proprietary. The CLA was the objection,
not the copyleft, and removing the CLA removes it.

## A DCO, because the reason for the CLA has gone

The CLA existed for two things ADR 0015 names: an internal commercial grant so Cando could depend
on an AGPL core (ADR 0011), and the option to change the licence later. The first is no longer a
question, since Apache-2.0 lets Cando depend on Graft like any other consumer. The second is being
exercised now, and this is the direction it was ever going to be exercised in.

What replaces it is a sign-off. `Signed-off-by` on each commit, `git commit -s`, checked by the
`DCO` workflow, certifying origin and nothing more. It takes no rights from a contributor and gives
the company none it does not already have under section 5.

## Considered options

- **Keep AGPL and swap the CLA for a DCO.** The narrowest fix for the audience objection, and the
  one to take if the copyleft were doing work. Rejected because it is not: it keeps the enterprise
  policy bans, it keeps a copyleft at the harness boundary where plugin authors live, and the Cando
  dependency would still need sole authorship or a grant from somewhere.
- **Keep AGPL and the CLA, with an outbound-FOSS guarantee written into it.** Survivable, and
  several projects run it. Rejected as the weakest option for this audience: a promise about future
  behaviour answers an objection that is about who holds the power, not about intent.
- **MIT for everything, core included.** The simplest thing to explain. Rejected because MIT grants
  no patent rights at all, and an express grant to users is exactly what Apache-2.0 adds over it;
  infrastructure that expects to be run by companies is conventionally Apache-2.0 for that reason.
  The skills stay MIT, where the shortness is worth more than the clause.
- **FSL or BSL, converting to a permissive licence after a delay.** ADR 0015 kept this as the
  fallback. Rejected: this audience does not count source-available as open source, and the cost is
  visible.

## Consequences and accepted risks

- **This direction is one-way, and that is the point at which it was taken.** ADR 0015's "order of
  operations is the safety" argument was right: loosening is an afternoon's work, tightening is
  impossible once a permissive version has shipped. The watching it asked for has happened, the
  reasons above are the finding, and the door is now open and stays open.
- **The relicensing needs nobody's consent but the company's.** Every commit on `main` on
  2026-09-21 is Aleks's or a bot's; no outside contribution has been merged. The `cla-signatures`
  branch holds two signatures, one the company's own on PR #3 and one on PR #108, which was closed
  unmerged. The branch is left where it is as the record of a process that ended.
- **A competitor may run the core, and could not usefully be stopped from doing so anyway.** What
  is sold is the hosted service, whose parts are absent from this repository (ADR 0002), and the
  cost of the loop is the model's, which is ADR 0014's subject.
- **`NOTICE` is now part of what downstreams must carry** (Apache-2.0 section 4(d)). It holds two
  lines, the product and the copyright, and should stay that short: every line added to it is a
  line every redistributor is obliged to reproduce.
- **ADR 0011's internal commercial grant is withdrawn** in that record's amendment of the same
  date. Cando adopting Graft is now an ordinary dependency.
- **The `DCO` check is not a required status check as this lands.** The ruleset on `main` requires
  `Typecheck, Lint & Test` alone, and the old `CLA` check was never required either, so removing it
  blocks nothing. Requiring the new one is a change to the repository ruleset and is the owner's to
  make.
- **What would reopen this**: a decision to sell licence exceptions as a revenue line. That needs a
  copyleft to have anything to except from, and it is the one business model this record closes off.
