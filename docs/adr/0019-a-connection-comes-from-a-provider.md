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
- **`request_connection` refused a proposal a link or no-step provider covered**, by name, until
  GRA-58 and GRA-59 gave each its flow (the bullets below): routing such a proposal to the
  keyring's form would have stored in Graft a credential the provider holds itself. Both flows have
  landed; with the keyring alone, every answer and every card is what it was before this record,
  and the suites pin it. With both providers configured the gateway is routed to first, since an
  operator's explicit host list is the more deliberate claim over a host than a broker's app table
  (`environmentProviders` in `apps/server/src/backings.ts`).
- **The gateway provider asks nobody, and an agent can never undo a person's decision** (GRA-58,
  2026-09-17). A proposal every host of which the configured gateway covers makes the row and puts
  it in the asking agent's scope in one transaction, and answers `connected` with no ask: the
  operator gave the standing consent at deployment by naming the hosts in `GRAFT_GATEWAY_HOSTS`,
  and the only consent a keyring ask carries — the secret typed for this agent — has no
  counterpart here. Coverage is *every* host, not any, because a connection's calls may go to each
  host it declares and a gateway fronting only some would relay the rest into a route it has no
  credential for. Where a person has decided, the agent's call is refused with the console step
  that would grant it, the smallest consent that exists today: a row the person revoked answers
  `connection_revoked` and stays revoked until the console's Reconnect (the one way back for a row
  that holds no credential to re-enter); a row the person has not given this agent — made for
  another, or taken out of this one's scope — answers `connection_not_in_scope` and is theirs to
  tick in the scope picker. A one-click ask for the second case is the least-cost connect UX the
  project defers. An in-scope row is "already connected" only when it reaches every host proposed;
  the gateway's own narrower row is widened to the union, within the gateway's coverage, rather
  than answered as a connection whose calls to the new host would fail `host_not_in_set`. **The vendor URL travels to the gateway in the path**,
  `<upstream>/<vendor host>/<vendor path>?<query>`, because that is how API gateways route — one
  route per covered host — and what Modern's forward proxy already spoke; a header naming the host
  was the alternative, and a gateway would have to read it before choosing a route. A revoked row
  of any provider now resolves to nothing for the proxy (`toProxyConnection`), since a relay row
  has no ciphertext for a revoke to clear.
- **The configured gateway is the one trusted private destination** (GRA-58, 2026-09-17), closing
  the egress question the first consequence above left open. The resolver's private-address rule
  guards against a host an *agent proposed* being pointed at the metadata service or a neighbour;
  the gateway's URL is the operator's, set in the environment beside the database URL, and the
  normal enterprise gateway sits on an internal hostname or a `10.x` address. So the gateway's
  hostname is exempt from the rule, by exact name, **on the relay leg's own fetch and on no other**:
  the provider brings the proxy a `createUpstreamFetch({ unguardedHosts })` on `ProxyRelay.
  upstreamFetch` (built in `apps/server/src/backings.ts`), the ladder sends a relayed hop through it
  and every signed call through the proxy's shared, fully guarded fetch. On the shared fetch the
  exemption would reach a *vendor* host spelling the gateway's name — a keyring connection an agent
  proposed at `gateway.corp.example` passes the literal check and would send its decrypted key to
  the private address (Greptile on #45) — so a vendor host is judged on its literal before any fetch
  and on its resolved address inside the resolver, exactly as before, whatever it is called. An
  IP-literal gateway was never resolved and so never guarded — Node connects to a literal without
  asking the resolver — which is why the suites address the fake gateway by a name, and why a
  literal upstream needs no exemption. A DNS answer for the gateway's own name is the operator's
  DNS to trust; a compromise there is a compromise of the gateway itself.
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
  Retry that runs the same release; a success clears both. The record is written only against a
  row still revoked with that same reference, because the release runs outside the revoke's
  transaction. A revoked row is reconnected in place by a later link only once its reference is
  cleared — while a release is outstanding, in flight or failed, a new row is made beside it, since
  writing over the reference would orphan the account at Pipedream. **One row per account at a
  provider** (`connection_provider_ref_idx`, partial on a non-null reference): a link's return that
  lands twice at once discovers the account before it writes, so the database refuses the second
  claim and that landing reads the ask the first answered.
- **Sign-in endpoints are not hosts, and are set aside before coverage** (Aleks, 2026-09-18;
  GRA-89). A connection's host set is where tool calls go, and no tool call reaches a sign-in
  endpoint under any provider: the console runs an OAuth exchange itself, a relay never touches the
  endpoints, and the proxy pins every call to the row's hosts. During GRA-35 Hermes proposed Gmail
  with `accounts.google.com` and `oauth2.googleapis.com` under `hosts` beside the API host, and the
  Pipedream provider's `covers`, which rightly demands every host be one of the vendor's own,
  declined it, so the person got the client-registration form instead of the one-click link. The
  rule, applied in `request_connection`'s normalisation so routing, the open-ask match, the card and
  the row all see one host set (`setAsideSignInHosts` in `packages/core/src/connection/
  connection.rules.ts`): the hosts of the proposal's own `authorizeUrl` and `tokenUrl`, and the
  scheme's well-known sign-in hosts (Google's two, for `oauth_authorization_code`), are dropped from
  `hosts` rather than merely ignored for coverage, and the answer names them. The primary host is
  never set aside and its hostname is never a sign-in host, since some vendors serve the token
  endpoint on the API's own host (Notion, Slack, HubSpot, Dropbox); a primary on a well-known sign-in
  host, or one that is the authorize or token endpoint URL itself, is refused as an invalid proposal
  with the reason. `covers` itself is unchanged: every remaining host must still be in the entry,
  because the relay injects the account's token into whatever vendor URL it is handed.
- **A revoked connection is refused as `connection_revoked`, and a row whose link never finished
  names its provider** (GRA-68, 2026-09-18). The proxy is handed the row's `revokedAt`
  (`ProxyConnection`) and refuses on it before it reads the scheme, the hosts or the credential:
  read off those columns, a revoked relay row answered `connection_not_ready` with "no scheme or
  primary host" for a row that has both, and a revoked keyring row "no credential yet", each sending
  the agent to repair the wrong thing when the one repair is the console's Reconnect, which the
  message now says. A link provider's row that is not revoked and holds no reference resolves
  `pending`, and the proxy's `connection_not_ready` names the provider that holds nothing for it
  yet. The proxy still knows nothing of what a provider is: the name is opaque text for that
  sentence, and a row handed to the proxy without the stamp is refused as before, through the
  nothing `toProxyConnection` resolves a revoked row to.
