# GRA-28 final report (the agent proposes a connection and the person enters the secret), PR #14

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Branch `aleks/gra-28-request-connection`, final SHA `cae66501a27ce6d70d9bac314e5bf9029d4cf231` (base `aleks/gra-26-console` at bba5f46, which carries GRA-23; `interface:` commit for the routes is `6c3a9e1`). Stacked PRs get no CI until retargeted to `main` (`ci.yml` runs on `pull_request: branches: [main]` only); GitHub reports #14 mergeable and clean. Linear GRA-28 In Review.

## Meta-tools (`packages/mcp/src/connection-request.ts`, wired in `tools/meta.ts`)

`request_connection`: input `{ vendor: string, primaryHost: string, scheme: enum(connectionScheme), displayName?: string, hosts?: string[], schemeConfig?: Record<string,string>, docsUrl?: string }`, `additionalProperties: false`, required `vendor, primaryHost, scheme`.
- connected (`isError` false): `{ status: "connected", connectionId, executeTool: "execute__<id>", message }`. Also answered at once, no ask, when a non-revoked credentialed connection at the same vendor + normalised primaryHost is already in the agent's scope.
- awaiting (`isError` true): `{ error: "awaiting_connection", reason: "awaiting_connection", pendingActionId, url, expiresAt (ISO), message }`; polls `GRAFT_APPROVAL_WAIT_SECONDS`; an identical normalised proposal returns the same action and link.
- refusals `{ error: "refused", reason, message, ...details }`: `host_not_public` (+`host`), `input_invalid` (+`field`), `connection_declined` (+`pendingActionId`), `handoff_expired` (+`pendingActionId`, when the ask expires during the wait).

`request_credential`: input `{ connectionId: string, reason?: string }`. Same connected shape (message says re-entered); awaiting `{ error: "awaiting_credential", reason: "awaiting_credential", … }`; refusals `connection_not_in_scope`, `connection_not_found`, `input_invalid`, `credential_declined`, `handoff_expired`. A revoked connection qualifies (the re-entry is the reconnection). Neither tool ever uses elicitation.

## Pending-action kinds

- `connection`: payload `{ vendor, displayName, scheme, schemeConfig, primaryHost (origin+path, normalised), hosts (all, lower-case, primary's included), docsUrl | null, note }`; `connection_id` column null.
- `credential`: payload `{ connectionId, vendor, connectionName, scheme, hosts, reason | null, revoked }`; `connection_id` stamped.
- Answer the console records: `{ connectionId }`; anything else (the generic `{ allow: false }`) reads as a decline. Nothing of the credential is ever on an action.
- New nullable `pending_action.connection_id` (FK set null, indexed), **migration `0001_pending_action_connection`** (kept as 0001; GRA-29 renumbers to 0002); GRA-23's `tool`/`build` asks now stamp it too.

## Server routes (person's session; `apps/server/src/api.ts`)

- `POST /api/pending-actions/:id/connection` `{ vendor, displayName, scheme, schemeConfig?, primaryHost, hosts?, credential: Record<string,string> }` → 201 `{ connection, pendingAction }`. One transaction: `registerConnectionWithCredential` → `addConnectionToAgentScope` (requesting agent only) → `answerPendingAction({ connectionId })`. 400 `details.reason: "host_not_public"` + `host`; 409 answered/consumed; 410 expired; 400 other kind; 404.
- `POST /api/pending-actions/:id/credential` `{ credential }` → 200 `{ connection, pendingAction }`; same refusals; no approval touched.
- `POST /api/connections` now accepts optional `credential` (row + ciphertext in one transaction).
- `POST /api/connections/:id/revoke` result gains `pendingActionsExpired`.
- Core: `registerConnectionWithCredential`, `addConnectionToAgentScope`, `HOST_NOT_PUBLIC`/`HostSetRefusal` (`validateHostSet` returns `reason` + `host`), `ConnectionDeps.expirePendingActionsForConnection` (revoke's third sweep stamps `expires_at` and `consumed_at`; closes GRA-23's per-call-yes edge).
- Env: nothing new.
- Known inconsistency to unify later as an `interface:` change: `PUT /api/connections/:id/credential` keeps body `{ fields }`; the new routes say `credential`.

## Web (`apps/web/src`)

Routes unchanged; `/pending/$id` dispatches two more kinds. Added: `lib/connection-form.ts` (+test; pure: `ConnectionDraft`, `DraftErrors`, `ConnectionRegistration`, `validateConnectionDraft(draft, { withCredential })`, `validateCredentialDraft`, `credentialFieldsFor`, `parametersFor`, `SCHEME_LABELS`, `presentField`, `parseHostList`, `hostsOf`, `draftFromProposal`, `emptyDraft`, `withScheme`), `components/connection/connection-form.tsx` (`ConnectionFormFields`, `HostsNotice`), `credential-fields.tsx` (`CredentialFields`), `add-connection-dialog.tsx`, `reenter-credential-dialog.tsx`, `components/pending/connection-ask-card.tsx`, `credential-ask-card.tsx`. Edited: `pending-action-queries.ts` (`Ask` kinds `connection`/`credential`, `readAsk`), `pending-action-card.tsx` (two branches), `ask-card.tsx` (`approveLabel`), `connection-queries.ts` (`createConnection`, `setConnectionCredential`, `submitConnectionProposal`, `submitCredentialRequest`), `connection-card.tsx` (Re-enter credential / Reconnect / Enter credential; revoked says "awaiting reconnection"), `connections.index.tsx` (Add connection), revoke dialog counts closed asks.

**Scheme table and host rule in the browser:** the form imports `@graft/core/connection/connection.rules` (now browser-safe; same `validateHostSet`/`validateSchemeConfig`/`validateCredentialFields` the service and meta-tool use), `@graft/proxy/credential-fields`, the new pure `@graft/proxy/scheme-parameters` (`SCHEME_PARAMETERS` moved there; core re-exports) and `@graft/proxy/types`. `@graft/core` and `@graft/proxy` became runtime deps of the web; `vite build` (first in `check-types`) is the proof no `node:crypto` reaches the bundle. Documented in AGENTS.md's console section; CONTEXT.md's *Meta-tool* lists both tools.

## Verified

- Suites: mcp `connection-request.test.ts` (14), server `connection-handoff.test.ts` (5, MCP + HTTP end to end incl. execute reaching the fake vendor with header injected and no token), `api.test.ts` +6, core/db/web units, rendered-SQL pin. `check`, `lint`, `check-types` 16/16, `test --force` `Cached: 0`. Postgres integration suite against 5440: 7/7 (migrates from the committed 0001).
- By hand on a live server (fresh `graft_gra28` DB on 5440, fake sandbox, console dev server, MCP client, standalone Chrome over CDP), httpbin included: link → pre-filled form → `169.254.169.254` refused under the input with the reason, nothing created → key entered → connected; list shows hosts + `credentialSetAt`, no ciphertext; agent A's scope has it, agent B's not; execute through `/c/<id>/h/httpbin.org/headers` and the plain form: httpbin echoed `X-Demo-Key: <key>`, no `Authorization`, no token in output; `request_credential` → card → new key → connected, `GET /api/approvals` unchanged, new key echoed; tampered link → refusal page; revoke with an open re-entry ask → `buildApprovalsDeleted: 1, pendingActionsExpired: 1`, card "awaiting reconnection", Reconnect dialog cleared `revokedAt`; Add connection with `basic` rendered username/password from the table.
- Not exercised: elicitation-capable clients (never used for these asks), the Docker backing, a browser test of the React form.

## Left behind

`graft_gra28` database on the shared 5440 Postgres; `apps/server/.env` in the worktree (gitignored).
