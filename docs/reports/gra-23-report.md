# GRA-23 final report (reads pass, writes ask once, destructive asks every time), PR #12

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Branch `aleks/gra-23-approvals`, final SHA `5d53cbd2c0e5333ba68b1cedbfa8ce6853f6bab2` (origin/main a1f9927 merged in). CI green. Local after the merge: `check`, `lint`, `check-types` 15/15, `test --force` `Cached: 0` 15/15 (mcp 82 across 10 suites, server 49 with 7 Postgres-backed cases skipped without `TEST_DATABASE_URL`). HTTP bodies unchanged since the interface commit `9809877`.

## Where the code lives

- `packages/mcp/src/approval.ts` — the gate and the ask flow; `packages/mcp/src/handoff.ts` — the signed URL; hook in `run.ts` inside GRA-24's `runHeld` (a tool whose ask is open is held in flight, never swept); build gate in `tools/execute.ts`; `session.ts` derives the channel from `getClientCapabilities().elicitation.form`.
- `apps/server/src/api.ts` — the routes; `index.ts` — wiring; `scripts/generate-keys.ts` prints `GRAFT_HANDOFF_SECRET`; AGENTS.md env block updated.
- Additive to GRA-6, no signature changed: `listPendingActionsByKind`, `deleteApproval` (repos, scope pinned in `scope.test.ts`); `revokeApproval`, `getPendingActionForPerson` (core); `deleteApproval` added to `ApprovalDeps` (one line in GRA-6's `approval.service.test.ts` fake).
- Tests: `packages/mcp/src/approval.test.ts` (17, handoff branch weighted per the OpenClaw finding), `handoff.test.ts` (5), `apps/server/src/approvals.test.ts` (3, an MCP ask answered over HTTP), `api.test.ts` (+13), env (+4), db (+2).

## Result shapes (all `isError: true`, JSON text block + `structuredContent`)

- `{ error: "refused", reason: "tool_denied", message }` — a standing `deny`.
- `{ error: "refused", reason: "approval_declined", message, pendingActionId? }` — declined in the console or by elicitation (`pendingActionId` on the handoff path); also an elicitation `cancel`, which records nothing.
- `{ error: "awaiting_approval", reason: "awaiting_approval", pendingActionId, url, expiresAt (ISO), message }` — not answered inside the wait; the action stays answerable.
- `{ error: "refused", reason: "approval_expired", message, pendingActionId }` — expired while the call waited; the next call asks afresh. Also `connection_not_found`.

## Elicitation (form mode, `elicitation/create`)

`message` names the agent, `<vendor>__<name>` (or the connection for a build ask), `displayName (vendor: hosts)`, and quotes the description "in the agent's model's own words". `requestedSchema`: `{ type: "object", properties: { allow: { type: "boolean", title: "Allow", description }, relax?: { type: "boolean", title: "Do not ask again for this tool", default: false } }, required: ["allow"] }` — `relax` only for a destructive tool. `accept` + `allow: true` → recorded, proceeds; `decline` or `accept` + `allow: false` → `deny` recorded (tool kind); `cancel` → nothing recorded. An elicitation that throws falls back to the handoff.

## HTTP (person's session via `requirePerson`; `ServiceError` → `{ error: CODE, message, details? }`)

- `GET /api/pending-actions` → `{ pendingActions: Card[] }` (open, all agents, newest first).
- `GET /api/pending-actions/:id?t=<token>` → `{ pendingAction: Card }`; 403 `FORBIDDEN details.reason:"tampered"` (missing or wrong `t`), 409 `CONFLICT "consumed"`, 410 `GONE "expired"`, 404.
- `POST /api/pending-actions/:id/answer` `{ allow: boolean, relax?: boolean }` → `{ pendingAction, approval?, buildApproval? }`; 409 already answered, 410 expired, 400 bad body. One transaction: kind `tool` → `setApproval(allow|deny)`, `relax` on a destructive tool → `relaxDestructiveApproval`; kind `build` + allow → `grantBuildApproval`.
- `GET /api/approvals?agentId=` → `{ approvals: ApprovalRow[] }`; `POST /api/approvals/:toolId/relax?agentId=` → `{ approval }` (400 if not destructive); `DELETE /api/approvals/:toolId?agentId=` → `{ approval }` (404 if none stood).
- `Card = { id, agentId, agent: { id, name } | null, kind: "tool"|"build", payload, expiresAt, createdAt, answeredAt, answer, consumedAt, url }`. Payload `tool`: `{ toolId, toolName, vendor, description, annotations: { readOnlyHint, destructiveHint }, connectionId, connectionName, hosts, note }` (`note` = the provenance sentence); `build`: `{ connectionId, vendor, connectionName, hosts }`.
- `ApprovalRow = { agentId, toolId, decision: "allow"|"deny", decidedAt, perCallRelaxed, owner, createdAt, updatedAt }`.

## Handoff token

URL `<GRAFT_CONSOLE_URL>/pending/<id>?t=<token>`; `t` = base64url(HMAC-SHA256(`GRAFT_HANDOFF_SECRET`, `"<id>\n<agentId>\n<expiresAt ms>"`)), 43 chars, no payload. The console lands on `/pending/<id>`, calls `GET /api/pending-actions/:id?t=` with the same `t`; the server recomputes the mark from the row (constant-time), then checks consumed, then expiry.

## For GRA-29

`requireBuildApproval(ctx: ServiceContext, scope: AgentScope, connectionId: string, deps: McpDeps, channel: AskChannel = NO_ELICITATION): Promise<GateOutcome>` where `GateOutcome = { pass: true } | { pass: false; answer: Record<string, unknown> }` (the answer is the body to return with `isError`). Exported from `@graft/mcp` with `AskChannel`, `NO_ELICITATION`, `gateToolCall`.

## Env

`GRAFT_CONSOLE_URL` (required, absolute http(s), path allowed), `GRAFT_HANDOFF_SECRET` (required, 32+), `GRAFT_APPROVAL_WAIT_SECONDS` (0–300, default 25), `GRAFT_PENDING_ACTION_TTL_HOURS` (1–168, default 24). `McpDeps.handoff: { consoleUrl, secret, waitMs, ttlMs, pollMs? }` and `ApiOptions.handoff: { consoleUrl, secret }`.

## Decisions

- **A decline holds; a dismissal does not.** Deny is recorded (the only writer of the `deny` GRA-6's rule reads); revoke via `DELETE /api/approvals/:toolId`. Build asks have no deny row, so a build decline just refuses.
- **A dry run passes the tool gate** (writes stop at the proxy; keeps `publish_tool` silent); the execute tool's build gate is not skipped for a dry run.
- **The answer endpoint consumes an answer the standing row carries in full.** CI caught the first cut's hole: a write tool's yes was never consumed and, after `DELETE`, was found and honoured. Unconsumed now only: a destructive tool's per-call yes and a build decline. **Known edge not closed:** a destructive per-call yes survives a connection revoke (GRA-6 deletes approvals, not pending actions) and would grant one call after reconnection. GRA-28 should close this when it confirms revoke semantics.
- **`agentId` is a query parameter on the approval routes.**
- **One open action per (agent, kind, target)**; a call that finds the earlier ask answered consumes it; a `CONFLICT` on consume re-reads the rule once.
- **Elicitation that fails falls back to the handoff.**
- Process slip disclosed in the fix commit: the server suite was not run locally before the first CI (Turbo's `test` depends on `^test`; an mcp failure skipped it). Re-verified with `pnpm --filter @graft/server test` directly.
