# Contributing to Graft

Graft's core is Apache-2.0 (`LICENSE`) and everything under `skills/` is MIT (`skills/LICENSE`).
ADR 0022 under `docs/adr/` is why.

Everyone taking part in this repository, in issues, pull requests and review, is asked to follow
the code of conduct in `CODE_OF_CONDUCT.md`, the Contributor Covenant 2.1.

## Running it

`AGENTS.md` is the guide for anyone working in this repository. Its **Commands** section has the
install, the checks, the database loop and the compose file, and the sections under it cover each
area. Start there rather than here; this file is only the part that is about contributing. The
short of it is Node 24 and pnpm 10, then `pnpm install`, then `pnpm run check`,
`pnpm run check-types` and `pnpm run test` before you push.

Read `CONTEXT.md` too. Every term is used in code, comments and copy exactly as it is defined
there, and where a term has an _Avoid_ list, the list is binding.

## Sign your commits off

Contributions come in under the [Developer Certificate of Origin](https://developercertificate.org)
1.1, not a contributor licence agreement. By signing off you certify that you wrote the change or
otherwise have the right to submit it under this repository's licence, and that the contribution
and the record of it are public. Nothing else is asked of you, and what you send in goes out under
Apache-2.0, the licence the rest of the repository carries.

Sign off by adding this line to every commit message, with your real name and address:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` writes it from your git identity, `git merge --signoff` signs a merge, and
`git rebase --signoff origin/main` adds the line to a branch already written. Every commit in the
pull request needs one, and the `DCO` check names any that lacks it. The one commit it does not
ask about is a merge GitHub itself makes, from the "Update branch" button, since nobody can sign
that one; a merge you make locally is yours and `git merge --signoff` signs it.

## Two rules before you write code

- **A pull request references a decision or a ticket, and its body is the build record.** Say what
  changed, the contracts a later change has to match, what was verified by hand and what was not,
  and any deviation with its reason. The decisions are in `docs/adr/`; cite the ADR your change
  turns on.
- **No vendor in this repository** (ADR 0002): no vendor's client library, configuration variable
  or id. What lives here is the seam, with the open form's backing or a no-op behind it; a vendor's
  backing lives in the private package. Before adding a dependency or a `GRAFT_*` variable, ask
  whether it is a vendor's.

## Tickets, reports and review

The tickets are in Linear, which is private, so a ticket identifier such as `GRA-123` is a name
rather than a link you can open. `docs/reports/README.md` is the index that maps each one to its
pull request here, and that pull request body is the public record of how the work was built.

Greptile reviews every pull request and edits its comment in place, so check the SHA it says it
reviewed. `main` is protected: merging needs one approving human review and a green
`Typecheck, Lint & Test`.
