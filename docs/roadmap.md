# Roadmap

Settled in the design session of 8 and 9 September 2026. Every decision is an ADR under
`docs/adr/`; this file is the order of work and the list of things deliberately later. The spec is
[GRA-1](https://linear.app/get-modern/issue/GRA-1) in the Linear team Graft; the launch tickets are
its sub-issues in the project *Graft launch: the loop end to end*, and the deferred items live in
the project *Graft roadmap*. Blocking edges are recorded in Linear; the tables here name them for
a reader without access.

## Build order (ADR 0016)

Nineteen slices, each verifiable on its own. Step numbers are ADR 0016's; several slices share a
step and run in parallel where their blockers allow.

| Step | Slice | Blocked by | Ticket |
| --- | --- | --- | --- |
| 1 | Repo scaffold and a real CI | none | [GRA-2](https://linear.app/get-modern/issue/GRA-2) |
| 1 | The proxy reaches a vendor through a host segment, placeholder stripped | GRA-2 | [GRA-5](https://linear.app/get-modern/issue/GRA-5) |
| 1 | The check learns SDK binding and derives annotations; the runner gains `proxyBase` | GRA-2 | [GRA-3](https://linear.app/get-modern/issue/GRA-3) |
| 1 | A sandbox seam with a Docker backing and a conformance suite in CI | GRA-2 | [GRA-4](https://linear.app/get-modern/issue/GRA-4) |
| 2 | Persons, agents, connections and toolbox rows, services without a database | GRA-2, GRA-5 | [GRA-6](https://linear.app/get-modern/issue/GRA-6) |
| 1 | Publish writes a version, vendors packages under the policy, moves the pointer | GRA-3, GRA-4, GRA-6 | [GRA-18](https://linear.app/get-modern/issue/GRA-18) |
| 3 | An agent connects over MCP and sees its working set | GRA-4, GRA-6, GRA-18 | [GRA-19](https://linear.app/get-modern/issue/GRA-19) |
| 3 | Reads pass, writes ask once, destructive asks every time (amended: destructive asks once too, GRA-52) | GRA-19 | [GRA-23](https://linear.app/get-modern/issue/GRA-23) |
| 3 | The working set contracts by cap and idle window | GRA-19 | [GRA-24](https://linear.app/get-modern/issue/GRA-24) |
| 5 | Spike: OpenClaw's MCP client against a running Graft | GRA-19 | [GRA-25](https://linear.app/get-modern/issue/GRA-25) |
| 2 | The console: sign in, agents, pending actions, working sets | GRA-23 | [GRA-26](https://linear.app/get-modern/issue/GRA-26) |
| 2 | The agent proposes a connection and the person enters the secret | GRA-19, GRA-26 | [GRA-28](https://linear.app/get-modern/issue/GRA-28) |
| 4 | `acquire` builds a tool with a scripted model | GRA-18, GRA-23, GRA-28 | [GRA-29](https://linear.app/get-modern/issue/GRA-29) |
| 5 | Gmail through a client the person registered: guided OAuth | GRA-5, GRA-28 | [GRA-30](https://linear.app/get-modern/issue/GRA-30) |
| 4 | A real model authors, the evals score it, the Hermes skill points at it | GRA-29 | [GRA-31](https://linear.app/get-modern/issue/GRA-31) |
| 1 | The private backings pass the conformance suite: Blaxel, KMS, S3 | GRA-4, GRA-18 | [GRA-20](https://linear.app/get-modern/issue/GRA-20) |
| 5 | One Docker image and a compose file run the whole loop | GRA-28, GRA-29 | [GRA-33](https://linear.app/get-modern/issue/GRA-33) |
| 5 | Graft Cloud deploys | GRA-20, GRA-33 | [GRA-34](https://linear.app/get-modern/issue/GRA-34) |
| 5 | Private alpha: the definition of done, twice | GRA-30, GRA-31, GRA-33, GRA-34 | [GRA-35](https://linear.app/get-modern/issue/GRA-35) |

## Self-improvement levels (ADR 0012)

| Level | What | When | Ticket |
| --- | --- | --- | --- |
| L0 | Static check, dry run, test input, outcome per version | Launch, in GRA-18 and GRA-29 | part of GRA-29 |
| L1 | Retry with a changed module inside one `acquire` when a dry run fails | Launch | part of GRA-29 |
| L2 | Repair: watch per-tool failure rate, re-run `acquire` against the failing trace, republish; read-only keeps approval, write asks again once | First feature after launch, needs weeks of failure data | [GRA-32](https://linear.app/get-modern/issue/GRA-32) |
| L3 | Harness mining: cluster failed authoring runs across customers, propose edits to the skill, prompts and checker, accept only on non-regressing evals | Internal weekly practice from the first week; recurring, owned by Aleks | [GRA-7](https://linear.app/get-modern/issue/GRA-7) |
| L4 | The outer agent's skills and instructions as edit surfaces | Never | none |

## Deferred, with the condition that brings each forward

| Item | Decision | Brings it forward | Ticket |
| --- | --- | --- | --- |
| Google first-party OAuth client on the hosted tier | ADR 0005 | People observed connecting Google through the guided BYO path; budget for verification plus annual CASA | [GRA-8](https://linear.app/get-modern/issue/GRA-8) |
| TLS-terminating egress proxy for SDKs that cannot rebase | ADR 0010 | An acquire run failing for want of it more than occasionally | [GRA-21](https://linear.app/get-modern/issue/GRA-21) |
| Curated package mirror for the hosted sandbox | ADR 0013 | Hosted launch | [GRA-9](https://linear.app/get-modern/issue/GRA-9) |
| MCP OAuth 2.1 for the harness to authenticate to Graft | ADR 0007, then ADR 0018 | Delivered for chat products by [GRA-53](https://linear.app/get-modern/issue/GRA-53): Graft is its own authorization server and the consent mints the agent. Hermes and OpenClaw keep the static token until their clients speak it | [GRA-10](https://linear.app/get-modern/issue/GRA-10) |
| Elicitation for approvals where the client supports it | ADR 0006 | In the launch build, behind a capability check | part of GRA-23 |
| Working-set addition raised in the design session, not captured | ADR 0009 | Aleks restates it; then spec | [GRA-22](https://linear.app/get-modern/issue/GRA-22) |
| Determinism gate at publish: evaluate the module's manifest twice, refuse if the two differ | Recommendation from `docs/research/executor-sh-teardown.md`, not yet an ADR | Considered in GRA-18 and found satisfied by construction: the publish never executes the module, its manifest (description, schema, dependencies) is data the caller and `package.json` supply, and the check is a pure function over the sources. Reopens the day a manifest is read by running the module | [GRA-11](https://linear.app/get-modern/issue/GRA-11) |
| OpenClaw as the second harness | ADR 0016 | A go from the spike GRA-25 | [GRA-27](https://linear.app/get-modern/issue/GRA-27) |
| A CLI wrapper that opens the console and catches an OAuth callback | ADR 0006 | Self-hosters asking for it | [GRA-16](https://linear.app/get-modern/issue/GRA-16) |
| Billing and the subscription, a spec before public launch | ADR 0014 | The alpha ending and a public launch scheduled | [GRA-17](https://linear.app/get-modern/issue/GRA-17) |
| Pricing revisit | ADR 0014 | The first hundred acquisitions counted | [GRA-12](https://linear.app/get-modern/issue/GRA-12) |
| Licence review | ADR 0015, then ADR 0022 | Done on 2026-09-21, before the repository was made public: the core is Apache-2.0, the skill and any harness plugin stay MIT, and a DCO replaces the CLA (ADR 0022). Reopens only on a decision to sell licence exceptions | [GRA-13](https://linear.app/get-modern/issue/GRA-13), [GRA-137](https://linear.app/get-modern/issue/GRA-137) |
| Cando adopts Graft as a dependency | ADR 0011 | Graft's core API stable | [GRA-14](https://linear.app/get-modern/issue/GRA-14) |
| Org tier UI and sharing | ADR 0007 | A customer asks | [GRA-15](https://linear.app/get-modern/issue/GRA-15) |

## Out of scope, and why

- **An integration catalog or a broker.** ADR 0001.
- **Acting as an MCP gateway in front of other servers.** ADR 0001.
- **Credentials handed to the sandbox as data.** ADR 0010, never.
- **Editing the outer agent's skills.** ADR 0012, L4, never.
- **A plugin system for third-party backings.** ADR 0002.
