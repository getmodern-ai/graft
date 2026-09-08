# Graft

**The agent grows the tools it needs onto its harness, and prunes what it stops using.**

Graft is a self-extending integration loop for people who run their own agent in
[OpenClaw](https://docs.openclaw.ai) or [Hermes](https://hermes-agent.nousresearch.com). When the
agent hits a task no tool covers, it asks Graft to acquire one. Graft's own coding model reads the
vendor's documentation, writes the smallest module that makes the call, checks it, dry-runs it
against the live API with writes stopped at a proxy, publishes it, and promotes it into that agent's
tool list. The credential never enters the code, the sandbox or the model. Later, when the agent
stops using the tool, it leaves the list again.

## What Graft is not

- **Not a catalog.** There is no pre-built integration library and no broker behind it. The model
  does the research, per person, per need.
- **Not a gateway.** Graft does not sit in front of your MCP servers and does not expose every tool
  of every app. An MCP server is one more source the agent may carve a slice from.
- **Not a harness.** It plugs into the one you already run, over MCP, as a handful of meta-tools
  plus exactly the tools currently promoted for that agent.

## How it will be used

One entry in the harness's MCP server list, pointing at Graft with a per-agent token, and one thin
skill that tells the agent: *when no tool covers the ask, call `acquire`.* Secrets and approvals
happen in a small web console the agent hands the person a link to.

Two forms, one core: **Graft Cloud**, hosted, and a **Docker image** for self-hosting. Both run
the same loop; they differ only in which sandbox, keyring and storage sit behind the seams.

## Status

Design complete, code not started. The design was settled in one session on 8 and 9 September 2026
and is recorded as one architecture decision record per decision under `docs/adr/`. The order of
work and the roadmap are in `docs/roadmap.md`. Read `CONTEXT.md` first for the vocabulary.

## Reading order

1. `CONTEXT.md`: the glossary. Every term below is used exactly as defined there.
2. `docs/adr/`: sixteen decisions, numbered in the order they were made.
3. `docs/roadmap.md`: the build order, the self-improvement levels, and the deferred items.
4. `docs/research/`: the teardown of executor.sh and the comparison with the Self-Harness paper
   that shaped the bet.

## Lineage

The core is copied from [Cando](https://github.com/getmodern-ai/cando)'s authored-tools framework
(ADRs 0025 to 0029 there) and folds in the forward-proxy shape and SDK-rebinding recipe from
Modern. Cando adopts Graft as a dependency once its API is stable (ADR 0011).

## License

The core server is AGPL-3.0. The skill and any harness plugin ship under MIT. The hosted backings
are private. See ADR 0015 for why, and for the conditions under which this changes.
