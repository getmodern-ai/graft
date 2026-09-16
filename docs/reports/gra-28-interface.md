# GRA-28 interface half (request_connection / request_credential), pushed at 6c3a9e1f895bc2b03cefebfb81116236bf846629 on `aleks/gra-28-request-connection` (based on gra-26-console at bba5f46, which carries gra-23)

Saved by the orchestrator from the implementing agent's interim report, 2026-09-09. Web work follows; final report will be `gra-28-report.md`.

## Meta-tools (`packages/mcp/src/connection-request.ts`, exported from `@graft/mcp`)

- `request_connection { vendor, primaryHost, scheme (enum of connectionScheme), displayName?, hosts?: string[], schemeConfig?: Record<string,string>, docsUrl? }`
  - connected: `{ status: "connected", connectionId, executeTool: "execute__<id>", message }` (`isError` false). Also answered at once, no ask, when a non-revoked credentialed connection at the same vendor+primaryHost is already in the agent's scope.
  - awaiting: `{ error: "awaiting_connection", reason: "awaiting_connection", pendingActionId, url, expiresAt, message }` `isError` true; an identical proposal returns the same action/link.
  - refusals `{ error: "refused", reason, message, ...details }`: `host_not_public` (+host), `input_invalid` (+field), `connection_declined` (+pendingActionId), `handoff_expired` (+pendingActionId, only when it expires during the wait).
- `request_credential { connectionId, reason? }` → connected as above (message says re-entered) | `{ error: "awaiting_credential", reason: "awaiting_credential", … }` | refusals `connection_not_in_scope`, `connection_not_found`, `input_invalid`, `credential_declined`, `handoff_expired`. Revoked connections qualify (reconnection).

## Pending-action kinds

- `connection`: payload `{ vendor, displayName, scheme, schemeConfig, primaryHost (normalised), hosts (all, lower-case), docsUrl|null, note }`, `connection_id` column null.
- `credential`: payload `{ connectionId, vendor, connectionName, scheme, hosts, reason|null, revoked }`, `connection_id` stamped.
- Answer recorded by the console: `{ connectionId }`; anything else (generic `{ allow: false }`) reads as a decline.
- New nullable column `pending_action.connection_id` (**migration 0001**), stamped by GRA-23's asks too. `revokeConnection`'s third sweep `expirePendingActionsForConnection` stamps `expires_at` and `consumed_at` on every open ask for the connection (closes GRA-23's edge); `RevokeConnectionResult` gains `pendingActionsExpired`.

## Routes (person's session)

- `POST /api/pending-actions/:id/connection { vendor, displayName, scheme, schemeConfig?, primaryHost, hosts?, credential: Record<string,string> }` → 201 `{ connection, pendingAction }`; 400 `details.reason "host_not_public"` + host; 409 answered/consumed; 410 expired; 400 wrong kind; 404.
- `POST /api/pending-actions/:id/credential { credential }` → 200 `{ connection, pendingAction }`; same refusals.
- `POST /api/connections` now takes an optional `credential` (one transaction), the console's Add connection.

## Core and proxy

Core: `registerConnectionWithCredential`, `addConnectionToAgentScope`, `HOST_NOT_PUBLIC` / `HostSetRefusal` (`validateHostSet` now returns reason + host). Proxy: `@graft/proxy/scheme-parameters` (`SCHEME_PARAMETERS` moved there, re-exported by core), browser-safe like `credential-fields`. GRA-29's build-approval hook is unchanged (`requireBuildApproval`); its ask now stamps `connection_id`.

## Migration order decided by the orchestrator

GRA-28 keeps migration `0001`. GRA-29 (which also generated a `0001`) merges this branch and regenerates its migration as `0002` on top, so the journal and `prevId` chain stay linear (`db:check-chain`).
