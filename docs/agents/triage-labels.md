# Triage labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repository's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

All five exist in the Graft team in Linear, each with a description naming the skill that applies
it; they predate this file (checked 2026-09-22).

## These are a different axis from the type labels

The Graft team also carries `Bug`, `Feature`, `Improvement` and `Infra`. Those describe **what a
piece of work is**; the five above describe **what state it is in**. They compose, and an issue
normally has one of each, `ready-for-agent` + `Feature`, say. Don't treat a type label as a triage
label or vice versa.

Linear also has workflow **states** (Backlog, Todo, In Progress, In Review, Done) which overlap
conceptually with the triage roles. The skills apply *labels*, not states, so the two are tracked
independently: a label says how ready the work is, a state says whether anyone has started it.

Edit the right-hand column to match whatever vocabulary you actually use.
