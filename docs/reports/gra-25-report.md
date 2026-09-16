# GRA-25 final report (OpenClaw spike), no PR; findings as a Linear comment on GRA-25

Saved by the orchestrator from the spike agent's report, 2026-09-09. Verdict: **go** for OpenClaw as the second harness (GRA-27). Roadmap issue GRA-36 filed.

## Setup tested

OpenClaw **2026.9.3** (commit `1391f7c`, npm `latest`; pins `@modelcontextprotocol/sdk` 1.30.0, the same as Graft) in an isolated prefix with a temp `HOME`, against Graft `main` 22a3445 on `PORT=3141`, fake sandbox, scratch database. A header-logging reverse proxy on `:3142` sat between OpenClaw and Graft. No provider key exists on the machine, so the client was exercised with `openclaw mcp probe` (the real bundle-MCP runtime: connect, `tools/list`, disconnect) plus source at tag `v2026.9.3`. The gateway was not driven through a model turn.

## Answers

**Q1, static `Authorization` header: yes, observed.** The bearer was on every request (initialize, initialized, tools/list, the standalone GET stream, DELETE) over plain http; the probe listed all 18 Graft tools. `${GRAFT_TOKEN}` expanded when set; unset, OpenClaw warned loudly, sent the literal, and Graft answered 401. Source: `mcp-transport.ts:207-212`, `env-substitution.ts:225`. OpenClaw issues #65590 and #70901 closed as implemented (2026-04-26); #61611 superseded; OAuth now ships. No token-in-URL workaround needed.

**Q2, `tools/list_changed`: yes, lazily.** `agent-bundle-mcp-runtime.ts:764-783` registers the SDK `listChanged.tools` with `autoRefresh: false` → `invalidateCatalog()`; the next turn's catalog load re-lists. Reproduced with OpenClaw's exact `Client` configuration against Graft's notifier: `onChanged` fired within ~1 s of a demote and a promote, and the following "turn" listed 17 then 18 tools. Mid-turn publishes stay covered by `run_tool` (ADR 0003).

**Q3, MCP elicitation: no, on any surface.** OpenClaw's `initialize` sent `caps={}`; `buildMcpClientCapabilities` (`runtime.ts:202-210`) declares no `elicitation`; no `ElicitRequestSchema` handler exists; SDK 1.30.0's `server.elicitInput` would throw before sending. OpenClaw's docs list Hermes' elicitation settings as "manual-review items"; the only elicitation OpenClaw surfaces is ACP (a different protocol). The handoff URL, GRA-23's branch for clients not advertising elicitation, is the path.

## Consequences for other tickets

- **GRA-36 (roadmap, Improvement):** OpenClaw exposes tools as `<server>__<tool>` truncated to 64 chars; Graft allows 128, so a long `<vendor>__<name>` gets cut, and meta-tool notes assert the unprefixed name.
- **GRA-27 / GRA-26 snippet:** OpenClaw read Graft's annotations; the `mcpServers` snippet for OpenClaw should use `"Bearer ${GRAFT_TOKEN}"` rather than a literal token.
- **ADR 0003 and ADR 0006** carry "unconfirmed" lines about OpenClaw's list_changed handling and elicitation support; both are now confirmed (yes lazily; no) and can be updated.

## State left behind

Graft server, proxy and OpenClaw processes stopped; scratch DB `graft_gra25` dropped; temp install, source clone and token files deleted; worktree `gra-25` removed and pruned. `graft-postgres` was stopped and its compose mapping changed to 5441 by the spike's `db:start`; the orchestrator brought it back up on **5440** (`GRAFT_POSTGRES_PORT=5440 docker compose up -d postgres`) with the volume untouched.
