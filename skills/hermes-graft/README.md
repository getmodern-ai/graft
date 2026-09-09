# `hermes-graft`

The thin Hermes skill (ADR 0016: Hermes first): one `SKILL.md` telling the harness's model when to
call Graft's `acquire`, how to relay a handoff, how to describe an approval, and what
`acquire_status` means while a job runs. Nothing else is installed into the harness — the tools come
from Graft over MCP, and the skill only points at them. Licensed MIT (`../LICENSE`), like every skill
here (ADR 0015).

## Format

`SKILL.md` follows the [agentskills](https://agentskills.io) open standard Hermes reads:
YAML frontmatter with `name` and `description`, then the body. `version` and `metadata.hermes`
are Hermes's own additions — its docs at
<https://hermes-agent.nousresearch.com/docs/user-guide/features/skills> — and are harmless to a
reader that does not know them.

## Installing it into Hermes

Skills live in `~/.hermes/skills/`, one directory each:

```bash
cp -r skills/hermes-graft ~/.hermes/skills/hermes-graft
```

or, from a published URL, `hermes skills install <url to SKILL.md>`.

## Pointing Hermes at Graft

The `mcp_servers` block at the end of `SKILL.md` is the shape Hermes documents for a remote server
at <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>: `url` and `headers`, with
`${VAR}` placeholders resolved at connect time from `~/.hermes/.env` or the environment — so the
agent token sits in `.env` and the config file holds no secret. Hermes registers a remote server's
tools as `mcp_<server>_<tool>`.
