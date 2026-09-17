# @graft/pipedream

The Pipedream Connect client behind the **Pipedream connection provider** (ADR 0019; GRA-59): a
vendor connects with one click through Pipedream's Connect Link, and every call for that connection
relays through Pipedream's Connect proxy, which holds the vendor's token. This package speaks
Pipedream's REST API and nothing of Graft's: it knows a project, an environment, a client id and
secret, an external user id and an account id, and the Connect endpoints those address.

Its own package rather than a corner of `@graft/core`, for the reason the boundaries give. The
provider that maps it onto the seam lives in `@graft/core` beside the keyring provider
(`connection/pipedream-provider.ts`); the relay plugin that rewrites a vendor request into the
proxy's lives in `@graft/proxy` beside the schemes (`pipedream-relay.ts`), because the proxy imports
nothing from any other `@graft/*` package and so cannot carry a client. What is left — one vendor's
REST surface, test-doubled whole — is this. Hand-rolled against the REST API rather than
`@pipedream/sdk`, as Cando's is (its `packages/api/src/lib/pipedream.ts`, ADR 0011): four calls do
not warrant a browser bundle, a second fetch stack and a second token cache, and a surface this small
can be read in full, which matters at the boundary where a mistake hands one person's account to
another.

## What it does

| Call | Pipedream endpoint | Used by |
| --- | --- | --- |
| `createConnectToken(externalUserId, …)` | `POST /v1/connect/{project}/tokens` | the link the console opens |
| `listAccounts(externalUserId, app)` | `GET /v1/connect/{project}/accounts` | confirming which account the person connected |
| `relayFields(externalUserId, accountId)` | none — the cached access token plus the ids | the proxy's relay, per call |
| `deleteAccount(accountId)` | `DELETE /v1/connect/{project}/accounts/{id}` | a revoke |

Graft's own access token is bought with the client credentials (`POST /v1/oauth/token`), cached
until a minute before it expires, and refreshed single-flight. **No call here reads a credential**
(`include_credentials` is never set): every call for a connected account relays through Pipedream's
proxy, which injects the token itself (the project's decision, ADR 0019). What Graft stores of a
connected account is its Pipedream account id, on the connection's `provider_ref` column; the
vendor's token never reaches this process.

The external user id Pipedream keys the person's accounts by is `graft-person-<personId>`
(`external-user-id.ts`): a stable prefix and Graft's own id, so a Pipedream project shared with
another product cannot collide, and an account listed for one Graft person cannot be another's.

## Fakes

`fake.ts` is an in-memory client for the suites that call the provider; `testing/fake-pipedream.ts`
is Pipedream itself on a loopback port — the token endpoint, the Connect token and accounts
endpoints, a Connect Link page that connects an account and sends the browser back, and the proxy,
which forwards the decoded vendor request to a handler the test supplies. `apps/server`'s proof
script runs the whole server against it.

Pipedream's documentation is the contract: <https://pipedream.com/docs/connect/api-proxy/>,
<https://pipedream.com/docs/connect/managed-auth/connect-link/> and the API reference under
<https://pipedream.com/docs/connect/api-reference/>.
