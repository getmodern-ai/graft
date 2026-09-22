<!--
This body is the build record docs/reports/README.md describes: the contracts a later change is
told to match, what was verified by hand and what was not, and any deviation and its reason. Fill
in each section; delete a section only if it truly does not apply, and say why in the section
above it if that is not obvious.
-->

## Ticket or decision

<!-- The Linear ticket this turns on (GRA-123), or the ADR. Linear is private, so an outside
contributor with no ticket can point at a GitHub issue number instead. -->

## What changed

<!-- One or two sentences on what landed and where. -->

## Contracts later changes should match

<!-- What a later ticket or PR can rely on: a shape, a function name, a rule. "None" if nothing
here is meant to be built on. -->

## Verified by hand

<!-- What you ran and saw, beyond the automated tests: a command, a screen, a live call. -->

## Not verified

<!-- What was left unverified, and why: out of scope, no access, deferred to a live check later. -->

## Deviations and why

<!-- Any place this diverges from the ticket, the ADR, or AGENTS.md, and the reason. "None" if it
followed the ticket as written. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`; the DCO check names any commit that lacks it)
- [ ] `pnpm run check`, `pnpm run check-types` and `pnpm run test` pass
- [ ] No vendor library, configuration variable or id was added to the open repository (ADR 0002)
- [ ] CONTEXT.md's vocabulary is used throughout, including any `_Avoid_` list it names
