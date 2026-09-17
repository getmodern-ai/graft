---
status: accepted
---

# A connection comes from a provider

Every connection belongs to a **provider**, and the provider decides two things Graft used to
hard-wire: how the person connects the vendor, and what happens to a vendor request at call time.
The provider is the fourth seam beside the sandbox, the keyring and the toolbox store (ADR 0002),
selected by the same backings mechanism: the open form enables the **keyring** provider alone, and
the hosted form may enable more, in an order, with the keyring always present and last. Three
providers are named: `keyring` — a secret entered in the console, held in the vault, injected by
the proxy under the scheme the connection names, which is every connection made before this
record; `gateway` — vendors behind a company's API gateway connect with no person step and every
call relays through it (GRA-58); `pipedream` — a vendor connects with one click through Pipedream
Connect and every call relays through its proxy (GRA-59). All three are open code; the hosted tier
supplies the Pipedream configuration.

**Relay everything for a brokered provider** (Aleks, 2026-09-17). A connection whose provider
holds the credential elsewhere never receives a raw token: every call is rewritten into a request
to the provider's upstream proxy, which injects the credential it holds and answers with the
vendor's response. Chosen over fetching the credential from the broker and injecting it here
because it is simpler — one mechanism, no credential cache, no window in which Graft holds a
token it did not issue — and because it works for any upstream that can be addressed with a URL
and authenticated to: a broker's Connect proxy, a company's gateway, anything shaped like either.
Cando took both branches (fetch-and-inject for apps on its own OAuth clients, relay for the rest)
and found the relay was the one that reached Gmail.

**The keyring path stays universal.** Every deployment has it, it covers every vendor, and it is
last in the routing order, so a vendor no other provider claims is connected exactly as it was
before this record. Nothing above the credential rung changes for any provider: the tool, the
sandbox, the capability token, the dry run and the host rules are the same for a relayed call as
for a signed one. What a provider changes is one rung — where a scheme plugin would attach a
decrypted credential, a relay plugin rewrites the request — and one person step.

## The seam

`@graft/core`'s `connection/provider.ts`: a provider has a `name`; a `connect` shape the console
and `request_connection` read — `form` over the proxy's schemes (today's form), `link` (a one-click
link the provider mints), or `none` (no person step); `covers(vendor, hosts)`, so a proposal is
routed to the first provider that covers it; `resolve(row)` to `inject` (the row's columns for the
proxy to decrypt and sign with) or `relay` (a plugin and the fields addressing the upstream); and
`revoke(row)`, which releases what the provider holds outside Graft after the row is revoked. The
connection service holds a registration's `provider` to the enabled list and to a `form` provider,
refuses a credential entered against any other provider's connection — it holds nothing here — and
asks the row's provider to release on revoke. The proxy's connection read asks the provider how the
call resolves and hands the answer on (`ProxyConnection.relay`); the proxy itself knows a
connection, a scheme, a host set, a token and now a relay, and nothing about providers.

A provider's **code is open while its configuration may be hosted**. Every plugin — the keyring's
schemes, the gateway's relay, Pipedream's relay — lives in this repository, so a self-hoster reads
what a hosted deployment runs; what the hosted tier holds is a Pipedream project and its token,
which reach the process as configuration through the private backings package (ADR 0002). That is
what "hidden by absence" means for a provider: the absence is of a configuration, never of code.

## What Cando's relay taught

Cando's `pipedream_connect_proxy` (its CAN-563 to CAN-567) is the parent of the relay engine here,
re-read on the way in (ADR 0011), and three of its lessons are now rules rather than a plugin's
private knowledge:

- **The header rules are data.** An upstream proxy has its own discipline for a caller's headers —
  Pipedream forwards one to the vendor only under an `x-pd-proxy-` prefix and refuses a documented
  list outright; a gateway that fronts the vendor forwards everything as-is — so the rules are a
  table (`RelayHeaderRules`: a prefix or none, what passes through under its own name, what is
  dropped, by name and by family) applied by one function every relay plugin calls. A plugin says
  *which* upstream and *how the vendor URL is carried*; the table says how the headers travel.
- **A header that already carries the prefix is prefixed again.** The upstream strips exactly one,
  so a caller sending `x-pd-proxy-authorization` would otherwise reintroduce the very header the
  outgoing policy stripped; doubled, it reaches the vendor as a harmless unknown.
- **A refused header is dropped, not prefixed.** Node's fetch sets `user-agent` on every request,
  Pipedream answers `400 Unsupported header` for it prefixed, and Cando's first relayed call in
  production failed on a header nobody chose. The vendor loses nothing it needed.
- **The relay's fields are held for the call and never persisted.** What addresses the upstream —
  its token, the ids naming the account there — is assembled when the request is about to leave,
  on the same rung as a decrypt: after the caller's body is accepted and after a dry run has
  intercepted a write, so a write in a dry run costs the upstream nothing and a refused call never
  assembles them. The proxy caches none of it; a provider that wants a token cached does so behind
  its own `obtain`.

## Consequences and accepted risks

- **Egress is judged on the vendor host, and the upstream's address on the socket.** The literal
  check runs against the vendor host the connection declares, as it always did; the relay URL is
  the provider's, and the resolver inside the upstream fetch refuses a private address for it as for
  any host. A company gateway on a private network therefore needs the egress rule relaxed for the
  relay leg, which is GRA-58's to decide and record.
- **A relay connection records its relay scheme in the `scheme` column**, so the column says how
  every row's request leaves and stays `NOT NULL`; the column's enum is the proxy's signing schemes
  plus its relay schemes, asserted equal in `packages/core`. The keyring refuses to sign for a
  relay scheme's name (`connection_not_ready`), and a relay provider ignores the column.
- **One `provider_ref` column, not one per provider.** The provider's own identifier for what a row
  is connected to — a broker's account id, a gateway's route — is opaque text, never a secret, and
  null for the keyring. Every relay provider named so far holds one identifier per connection; one
  that comes to need more adds a column named for itself then. Chosen over a JSON column because a
  single opaque identifier needs no shape to read and no shape to migrate.
- **A row under a provider the deployment no longer enables resolves to nothing**, and the proxy
  answers `connection_not_ready` for it. Saying so is better than guessing at the keyring: the row
  was made under a provider that held its credential, and this process cannot reach it.
- **The redirect and echo rules apply to a relayed call as to any other.** A vendor `Location` the
  upstream passes through is judged against the vendor's host set, and a hop the break glass allows
  is relayed again; a credential value the upstream echoes — its own token, quoted in a refusal —
  is redacted on the way back as a vendor's echoed key is.
- **Two more refusals a module may read**: `relay_unavailable` (502) when the upstream cannot be
  addressed, and `credential_incomplete` (409) when the relay's fields lack what the plugin needs,
  the same word an incomplete signing scheme earns. The event carries `relay` — the scheme the call
  left through — beside the vendor `host` and `path` it always named.
- **`request_connection` refuses a proposal a link or no-step provider covers**, by name, until
  GRA-58 and GRA-59 give each its flow: routing such a proposal to the keyring's form would store
  in Graft a credential the provider holds itself. With the keyring alone, every answer and every
  card is what it was before this record; the suites pin it.
- **The Pipedream provider stores one fact and never the other** (2026-09-17, GRA-59). What Graft
  keeps of a connection made through Pipedream Connect is the Pipedream account id on
  `provider_ref`, the relay scheme `pipedream_connect_proxy` in `scheme`, and the vendor and host
  set the proposal named; the row's `credential_ciphertext` is null for its whole life. What Graft
  never holds is the vendor's token: Pipedream's proxy injects it per call, the Connect client
  never asks for account credentials (`include_credentials` is set on no call), and what the relay
  assembles per call is Graft's own Connect access token and the ids that name the account —
  held for the call and cached only as the client's token cache. The person is keyed at Pipedream
  by `graft-person-<personId>`, so a shared project cannot mix accounts across products or
  persons. Pipedream's API does offer account deletion (`DELETE /v1/connect/{project}/accounts/{id}`),
  and revoke calls it. **A failed release is a fact on the row, not a toast**: the revoke keeps
  `provider_ref` until the provider has let go — the reference is what the retry releases by — and
  stamps `provider_release_failed_at` when it has not, which the connection card shows with a
  Retry that runs the same release; a success clears both. A revoked row whose release is still
  outstanding is not reconnected in place by a later link, since overwriting its reference would
  orphan the account at Pipedream; a new row is made beside it.
