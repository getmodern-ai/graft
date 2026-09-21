# Skills

Everything under `skills/` is licensed MIT; the licence text is in `LICENSE` beside this file. The
rest of the repository is Apache-2.0 under the root `LICENSE`. A skill is the one part of Graft
that is installed into a person's harness, which is where the boundary falls; ADR 0022 holds the
argument for the split, and ADR 0015 is the record it superseded.

One skill lives here: [`hermes-graft/`](./hermes-graft/README.md), a `SKILL.md` in the agentskills
format that tells Hermes when to call `acquire`, how to relay a handoff, how to describe an
approval, and what `acquire_status` means while a job runs (ADR 0016; GRA-31). Its README says how
it is installed and how Hermes is pointed at a Graft server.
