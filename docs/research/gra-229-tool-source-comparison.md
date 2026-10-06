# Which tool source should come first? Pipedream against the alternatives (GRA-229)

Research for the wayfinder map GRA-220. Read 2026-10-06 and 2026-10-07. Terms follow `CONTEXT.md`
as amended while charting: a **stock tool** is what a **tool source** offers for a connection;
*action*, *toolkit* and *tool pack* are the sources' own words. Pipedream is the baseline and is
not redone here: its figures are GRA-221's (`research/gra-221-pipedream-coverage`).

Method: primary sources only (vendor docs, terms, pricing pages, GitHub repositories and their
`LICENSE` files, the vendors' own `/.well-known` OAuth metadata and unauthenticated `tools/list`
where a server answers one). Each claim below carries its source; a claim nobody could confirm is
marked **unconfirmed**. No vendor code was run; spec files were downloaded to a scratch directory
outside the repository and only counted.

## The answer in short

**Start with Graft-authored stock, run through the proxy over any connection; keep Pipedream
actions as the hosted form's breadth source behind the same seam, gated on written terms.**

- Graft-authored stock is the only candidate that scores well on every axis that cannot be bought
  later: terms (nothing to licence), proxy and custody (ADR 0010 unrelaxed), self-host (any
  connection, including keyring), and vendor risk (none). Its cost is one-off: about 70 tools for
  the eight starters (lists below), authored by Graft's own loop and reviewed by a person, plus the
  piece that does not exist yet, a toolbox shared across persons. It also covers Unleashed, which
  no other source does well: the proxy already signs `unleashed_hmac` (`packages/proxy/src/schemes.ts`).
- The vendors' own OpenAPI and Discovery specs are not a source on their own (endpoint-as-tool is
  what the field moved away from), but they are the authoring loop's best input for the basics.
- Pipedream remains the fastest way to *breadth* on the hosted form (2,000+ apps, connections
  already relayed there), but it is the one source whose terms are a grey area for exactly what
  stock tools do (list, cache, show); ask Pipedream in writing before building on it.
- Vendors' remote MCP servers are not a first source: of the eight starters only GitHub (GA) and
  Notion (beta) are usable by a third-party product today; Google's are a developer preview that
  bars public apps, Slack's needs a Marketplace-published app, HubSpot's needs its own MCP auth
  app and token issuer, and Unleashed has none. Worth a second look per vendor in 2027.
- Brokers: none beats Pipedream for this use. Composio is cheapest and broadest but never releases
  a token (so no relay through Graft's proxy), its terms bar commercial and derivative use, and it
  had a token breach in May 2026. Arcade has the best-designed tools but proprietary toolkits and
  a no-resale clause. Klavis's Apache-2.0 servers are the only broker code a self-host could take,
  but the company has pivoted and the repository is stale. Nango, Merge and Paragon are
  enterprise-shaped and custodial.

## Scoring

Each axis 1 (poor) to 5 (good) for Graft's use: stock tools for the eight starters, found by
`find_tool`, run by `run_tool`, in Claude.ai and ChatGPT. Cost and latency are given as figures
where a source states them.

| Source | Tool quality | Starter basics covered | Terms | Proxy and custody fit | Self-host | Cost per call | Latency | Vendor risk |
|---|---|---|---|---|---|---|---|---|
| Pipedream actions (baseline) | 3: 65% one call, ids named in 5 of 168 props, props translated | 4: 7 of 8 (Unleashed barely) | 2: source-available; §4.4 on redistribution is grey | 2: runs in Pipedream; ADR 0010 relaxed | 1 | 1 credit per 30 s, $0.012 past plan | one hop to Pipedream's runtime (unmeasured) | 3: Workflows end 2027-03-31, Connect kept |
| Vendor remote MCP | 4: curated, annotations (Google); no Gmail send | 2: usable now for GitHub, Notion only | 3: per vendor; Google preview bars public apps, Slack needs Marketplace | 4: plain HTTPS bearer, fixed host; but Notion and HubSpot need their own token issuer | 3: works if the operator registers OAuth apps | free | direct to vendor | 3: eight separate contracts |
| Composio | 3: JSON Schema, hints, many endpoint wrappers | 4: 7 of 8 | 2: ToS bars commercial and derivative use; needs legal read | 1: never releases the token | 1: Enterprise only | $0.0003 (Pro), 100k free | Composio cloud hop | 2: May 2026 token breach |
| Arcade | 5: hand-built, behaviour flags map to hints | 3: 7 of 8, thin (Calendar 8, Slack 10) | 2: no resale; needs an agreement | 2: raw token readable, tools run at Arcade | 1: proprietary toolkits | $0.01 | Arcade cloud or own workers | 3 |
| Klavis (Strata, OSS servers) | 3: self-reported evals | 4: 7 of 8 servers | 4: Apache-2.0 code; hosted terms unconfirmed | 3: fork-and-own servers, adapt to the proxy | 4: but unmaintained | n/a (hosted pricing gone) | n/a | 1: pivoted to training data |
| Nango | 3: multi-step actions, no evals | 4: 7 of 8, ~50 each | 3: built to embed; ELv2 code | 3: raw token and a proxy, actions run at Nango | 1: tools are cloud/Enterprise | $0.72/compute-hour + $0.29/connection | Nango runners | 3 |
| Merge Agent Handler | 4: tuned, overridable descriptions | 4: 7 of 8 | 3: built to embed | 1: custodial, no token access found | 1 | ~$0.04 ($1,000 per 25k) | adds a scanning gateway | 3 |
| Paragon ActionKit | 3 | 2: thin (Slack 7, Gmail 9) | 3 | 2: custodial, has a proxy | 1 | quote | Paragon cloud | 3 |
| OpenAPI-derived, endpoint-as-tool | 2: as raw endpoints; 4 curated | 3: specs usable for 5 of 8 | 4: vendors' own specs | 5: runs through the proxy | 5 | ~0 (sandbox or server fetch) | direct | 5 |
| Graft-authored stock, shared | 4–5: written for models, dry-run verified, reviewed | 5: all 8, Unleashed included | 5 | 5: ADR 0010 unrelaxed, any provider | 5 | sandbox exec only | sandbox exec + vendor (unmeasured) | 5 |

The two rows that win on the axes Graft cannot buy later (terms, custody, self-host, vendor risk)
are the last two, and they are the same idea: the spec is the input, an authored tool is the
output.

## 1. Pipedream actions (baseline, GRA-221)

332 actions across the eight; 216 (65%) run in one call, 324 (98%) once the model holds an id, 8
dynamic. Annotations on all; three read-only tools can write. Props are not JSON Schema and the
translation is Graft's (`withLabel`, `file-ref`, prose-only `object`). Unleashed is barely usable.
Terms: components are under the Pipedream Source Available License (no competing SaaS), so Graft
calls the API and never runs their code; Terms §4.4 forbid redistributing "any portion of the
Service", so caching and displaying the catalogue needs written permission (GRA-220's first
comment). What it has that nothing else here has: the hosted form's connections already come from
Pipedream (ADR 0019, GRA-59/GRA-103), so a stock tool needs no second connect step.

## 2. Vendors' official remote MCP servers

| Starter | Server | Status | Auth | Tools | Reuse Graft's REST token? |
|---|---|---|---|---|---|
| Gmail | `gmailmcp.googleapis.com/mcp/v1` | Developer Preview from 2026-05-01 | Google OAuth, own Cloud client with the product's "MCP API" enabled; no DCR/CIMD | 23, every one annotated with output schema; **no send** (drafts only) | likely, same scopes (inferred, untested) |
| Google Calendar | `calendarmcp.googleapis.com/mcp/v1` | Developer Preview | as Gmail | 9 | likely |
| Google Drive | `drivemcp.googleapis.com/mcp/v1` | Developer Preview | as Gmail | 8 | likely |
| Slack | `mcp.slack.com/mcp` | GA 2026-02-17 | confidential OAuth, own app, "no Dynamic Client Registration"; "only apps published in the Slack Marketplace and internal apps" | ~20 capabilities; names, annotations unconfirmed | unconfirmed |
| Notion | `mcp.notion.com/mcp` | "Notion MCP (Beta)" | OAuth + PKCE, open registration and CIMD | 36 (some Business/Enterprise only) | no: hosted server needs its own OAuth |
| GitHub | `api.githubcopilot.com/mcp/` | GA 2025-09-04; MIT, self-hostable | GitHub OAuth app or PAT; no DCR | 25 toolsets, defaults context/repos/issues/pull_requests/users; `ReadOnlyHint` in code | yes (inferred, same token system) |
| HubSpot | `mcp.hubspot.com` | GA 2026-04-13 | OAuth 2.1 + PKCE through a pre-created "MCP Auth App"; its own token issuer | 31 (16 reads, 12 `manage_*` writes) | no |
| Unleashed | none found | | | | |

Sources: Google [configure MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers),
[Workspace Updates 2026-05](https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html),
[Gmail MCP reference](https://developers.google.com/workspace/gmail/api/reference/mcp), tools listed
unauthenticated by `tools/list`; Slack [MCP server](https://docs.slack.dev/ai/slack-mcp-server.md),
[changelog 2026-02-17](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/); Notion
[get started](https://developers.notion.com/guides/mcp/get-started-with-mcp),
[build a client](https://developers.notion.com/guides/mcp/build-mcp-client),
[supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools); GitHub
[GA changelog](https://github.blog/changelog/2025-09-04-remote-github-mcp-server-is-now-generally-available/),
[repo](https://github.com/github/github-mcp-server),
[remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md);
HubSpot [GA changelog](https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available),
[integrate guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server);
Unleashed [product page](https://www.unleashedsoftware.com/en-us/product/ai-inventory-management-software/).

Terms that decide it:

- **Google**: the Developer Preview Program says pre-GA features "may not be included in public
  applications prior to the General Availability (GA) announcement", and not offered to users
  outside your own organisation without Google's grant ([preview](https://developers.google.com/workspace/preview)).
  After GA, Gmail's read/modify scopes and `drive`/`drive.readonly` stay **restricted scopes**
  needing verification ([restricted scopes](https://support.google.com/cloud/answer/13464325)),
  which a hosted Graft needs for its own Google client anyway.
- **Slack**: the 2025-05-29 API terms make the Marketplace "the only appropriate channel for
  commercially distributing apps", and non-Marketplace apps get `conversations.history` cut to one
  request a minute ([ToS changelog](https://docs.slack.dev/changelog/2025/05/29/tos-updates/),
  [rate limits](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).
  This bites every Slack source that uses Graft's own Slack app, not only MCP.
- **Notion, GitHub**: no clause found limiting third-party clients; Notion's enterprise admins can
  deny MCP clients ([admin API](https://developers.notion.com/reference/admin/list-mcp-client-connections));
  GitHub Copilot Business/Enterprise organisations must enable the MCP policy.

Proxy fit: every server that exists is streamable HTTP to a fixed host with a bearer header, so the
proxy could inject the token and pin the host. The cost is connections: Notion and HubSpot issue
their own tokens, so a person would connect twice (once for REST, once for MCP), and Graft would be
an MCP client relaying a whole server, which is the shape ADR 0001 rejects unless the source only
ever offers a slice through `find_tool` (the "sourcing gateway" rule GRA-220 settled).

## 3. Agent-tool brokers

| Broker | Schema and search | Starter tool counts (Gmail/Cal/Drive/Slack/Notion/GitHub/HubSpot) | Unleashed | Terms for embedding | Self-host, licence | Price | Credential custody |
|---|---|---|---|---|---|---|---|
| Composio | JSON Schema in and out; MCP hints as filterable tags; `query` search and `COMPOSIO_SEARCH_TOOLS` | 61/44/76/145/45/846/244 | no | consumer-agent guide and DPA name end users, **but** ToS licence "does not include any resale or commercial use … any derivative use … data mining" | SDK MIT; platform self-host Enterprise only | free 100k calls/mo; Pro $29 + $0.0003/call | holds tokens, never returns them since the May 2026 breach; Proxy Execute injects on their side |
| Arcade | `/v1/tools`, `/v1/tools/search`, `formatted_tools`; `behavior` flags map to all four hints | 30/8/16/10/10/43/40 | no | "Unauthorized sharing or reselling of our service" barred; no explicit embed clause | Helm chart, VPC Enterprise; toolkits "Proprietary – Arcade Software License Agreement" | free 2k calls; $0.01/call, $0.10/auth | holds tokens; raw token readable by the caller |
| Klavis | MCP-native list; Strata progressive discovery, "no semantic search" | servers for all 7 (not counted) | no | white-label OAuth; hosted terms unconfirmed | **Apache-2.0**, Docker per server; last push 2026-06-01 | pricing page now sells training environments | holds tokens; stored auth retrievable (inferred) |
| Nango | `scripts/config?format=openai`; agent-session MCP with `nango_tool_search` | 54/43/32/53/44/46/49 | no (not among ~1,041 providers) | built to embed; ToS bars copying or distributing the service | **Elastic License 2.0**; free self-host is auth+proxy only, no tools | $50/mo + $0.29/connection + $0.72/compute-hour | holds tokens; `GET /connection` returns raw credentials; full proxy |
| Merge Agent Handler | `<connector>__<tool>`, JSON Schema, `search_tools` meta-tool | 23/34/43/50/20/118/78 | no | built to embed, one Registered User per end user; caching clause unconfirmed | closed; on-prem Enterprise | free 2k credits; Pro $1,000/25k credits | custodial, AES-256; no token access found |
| Paragon ActionKit | JSON Schema `{function}` list by category | 9/12/10/7/16/~25/~36 | no | embedded iPaaS, white-label portal on Pro | on-prem Enterprise; MCP server MIT but calls their cloud | quote | custodial; Proxy API |

Sources: Composio [tools API](https://docs.composio.dev/reference/api-reference/tools/getTools),
[meta tools](https://docs.composio.dev/toolkits/meta-tools), [terms](https://composio.dev/terms),
[pricing](https://composio.dev/pricing), [token custody](https://docs.composio.dev/docs/security/token-custody),
[May 2026 incident](https://composio.dev/blog/composio-may-2026-security-incident); Arcade
[OpenAPI](https://api.arcade.dev/v1/swagger), [metadata](https://docs.arcade.dev/en/build/create-tools/tool-basics/add-tool-metadata),
[integrations](https://docs.arcade.dev/en/resources/integrations), [terms](https://www.arcade.dev/terms-of-service/),
[pricing](https://www.arcade.dev/pricing), [arcade-gmail on PyPI](https://pypi.org/pypi/arcade-gmail/json),
[OAuth2 provider](https://docs.arcade.dev/en/references/auth-providers/oauth2); Klavis
[Strata](https://www.klavis.ai/docs/concepts/strata.md), [repo](https://github.com/klavis-ai/klavis),
[homepage](https://www.klavis.ai/); Nango [agent sessions](https://nango.dev/docs/guides/agent-sessions.md),
[integration-templates](https://github.com/NangoHQ/integration-templates),
[LICENSE](https://github.com/NangoHQ/nango/blob/master/LICENSE), [self-hosting](https://nango.dev/docs/guides/platform/self-hosting/self-hosting.md),
[pricing](https://www.nango.dev/pricing), [terms](https://www.nango.dev/terms),
[get connection](https://nango.dev/docs/reference/backend/http-api/connections/get.md); Merge
[how it works](https://docs.merge.dev/merge-agent-handler/how-it-works.md),
[billing](https://docs.merge.dev/merge-agent-handler/administer/billing-and-usage.md),
[pricing](https://www.merge.dev/pricing/agent-handler); Paragon
[ActionKit for tool calling](https://docs.useparagon.com/actionkit/actionkit-for-tool-calling.md),
[pricing](https://www.useparagon.com/pricing), [paragon-mcp](https://github.com/useparagon/paragon-mcp).

Common to all six: each is a second connection system. A person who connected Gmail through the
hosted form's Pipedream provider would connect again through the broker, unless the broker becomes
a connection provider too (ADR 0019), which for Composio and Merge means Graft's proxy never sees
the call. None covers Unleashed. None publishes evals of its own tools for the starters beyond
Klavis's self-reported MCPMark figures.

## 4. Tools derived from vendors' specs, run through the proxy

| Starter | Spec | Format | Size | Operations | Updated | Usable? |
|---|---|---|---|---|---|---|
| Gmail | `gmail.googleapis.com/$discovery/rest?version=v1` | Google Discovery | 218 KB | 79 | rev 20260928 | yes, but send takes base64url RFC 2822 `raw`, which a plain tool cannot hand a model |
| Google Calendar | `googleapis.com/discovery/v1/apis/calendar/v3/rest` | Discovery | 170 KB | 38 | rev 20260930 | yes |
| Google Drive | `googleapis.com/discovery/v1/apis/drive/v3/rest` | Discovery | 270 KB | 64 | rev 20261001 | yes |
| Slack | `slackapi/slack-api-specs` | Swagger 2.0 | 1.2 MB | 174 | last spec commit 2020-10-06; archived 2024-03-27 | **no**: stale, lacks `files.getUploadURLExternal` |
| Notion | `developers.notion.com/openapi.json` | OpenAPI 3.1 | 1.3 MB | 64 | 2026-10-05 | yes |
| GitHub | `github/rest-api-description` | OpenAPI 3.0.3 | 13 MB | 1,232 | 2026-10-06 | yes, searched not loaded |
| HubSpot | `api.hubapi.com/public/api/spec/v1/specs` (123 APIs) | OpenAPI 3.0, per API and version | Contacts 76 KB | Contacts 13 | 2026-10-06 | yes, split; repo README said "not intended for external use" (via a mirror, unconfirmed) |
| Unleashed | none found | docs pages only | | 39 resource pages | | **no** spec |

Google publishes Discovery, not OpenAPI; converters exist (`gnostic disco --openapi3`,
stackql's `google-discovery-to-openapi`). Measured 2026-10-07 by downloading and counting.

How model-friendly endpoint-as-tool is, from the people who built it:

- Cloudflare: one tool per endpoint for its 2,500-endpoint API "would consume 1.17 million
  tokens"; Code Mode exposes `search()` and `execute()` in about 1,000 ([2026-02-20](https://blog.cloudflare.com/code-mode-mcp/),
  [2025-09-26](https://blog.cloudflare.com/code-mode/)).
- Stainless removed every MCP tool scheme except Code Mode on 2026-01-13
  ([changelog](https://www.stainless.com/changelog/mcp-servers-now-support-code-mode-only)).
- executor.sh stores each operation as a tool but exposes `search`, `execute` and `resume` over
  MCP; reads run, `post/put/patch/delete` require approval (`packages/plugins/openapi/src/sdk/invoke.ts`).
- Speakeasy: "expose only the tools that task needs" ([curation](https://www.speakeasy.com/docs/gram/build-mcp/advanced-tool-curation)).
- Anthropic: selection "degrades once you exceed 30–50 available tools"; tool search raised
  accuracy 49% → 74% (Opus 4) and 79.5% → 88.1% (Opus 4.5); tool-use examples 72% → 90% on
  complex parameters ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool),
  [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)). OpenAI: "fewer than
  20 functions" at the start of a turn ([function calling](https://developers.openai.com/api/docs/guides/function-calling)).
- arXiv 2507.16044: official MCP servers expose a median 19% of an API's operations and 92% are
  bare wrappers; generation from 80 OpenAPI files worked for 76% of sampled tools, 94.2% after
  repair, failures caused by the specs ([abstract](https://arxiv.org/abs/2507.16044)).
- GitHub merged its MCP tools into method-parameter tools on 2025-10-29 for "AI reasoning clarity"
  ([changelog](https://github.blog/changelog/2025-10-29-github-mcp-server-now-comes-with-server-instructions-better-tools-and-more)).

Graft already has the search half (`find_tool` over a slice, never the whole list) and the code
half (the sandbox and `acquire`). What a spec gives Graft is not a tool per endpoint but the facts
an author needs. Endpoint-as-tool fails exactly where the basics are hardest: Gmail send (MIME),
HubSpot's object-type genericity, Slack (no current spec), Unleashed (none).

## 5. Graft-authored stock

The basics a person would expect, per starter (my own reading of each API, not measured against
usage; the counts are the point, not the exact cut). R is a read (never asks, ADR 0008), W a write.

| Starter | Basics | Count |
|---|---|---|
| Gmail | search messages (R), get thread (R), get message with attachments listed (R), send email with to/cc/subject/body/reply-to-thread (W), create draft (W), reply to thread (W), list labels (R), add/remove labels incl. archive and mark read (W), download attachment as a blob (R) | 9 |
| Google Calendar | list calendars (R), list events in a window (R), get event (R), find free time / free-busy (R), create event with attendees and Meet link (W), update event (W), delete event (W), respond to invitation (W) | 8 |
| Google Drive | search files (R), list recent files (R), get file metadata (R), read file content, exporting Docs/Sheets to text (R), download file as a blob (R), upload a file from a blob (W), create folder (W), move/rename (W), share with a person (W) | 9 |
| Slack | list channels (R), read channel history (R), read thread (R), search messages (R), find user by name or email (R), post message (W), reply in thread (W), send direct message (W), add reaction (W), upload a file from a blob (W) | 10 |
| Notion | search pages and databases (R), get page with content as text (R), query a database with filter (R), list users (R), create page (W), append content to a page (W), update page properties (W), add comment (W) | 8 |
| GitHub | list my repositories (R), list issues (R), get issue with comments (R), search issues and pull requests (R), list pull requests (R), get pull request with diff summary (R), get file contents (R), create issue (W), comment on issue or PR (W), update issue state/labels/assignees (W), create pull request (W) | 11 |
| HubSpot | search contacts/companies/deals by name or email (R), get a record with associations (R), list owners (R), list pipelines and stages (R), create contact (W), create company (W), create deal in a pipeline stage (W), update a record's properties (W), add a note to a record (W), create a task (W) | 10 |
| Unleashed | list products (R), get stock on hand (R), list sales orders with filters (R), get sales order (R), list customers (R), list purchase orders (R), create sales order with lines (W), create purchase order with lines (W), create stock adjustment (W) | 9 |
| **All eight** | | **74** |

Every one of these is a module the loop already knows how to write: `ctx.fetch` through the proxy,
dry-run proved, annotated, with `ctx.blob` for the attachment and file rows (ADR 0023). The id
problem GRA-221 found in Pipedream (108 props needing an id nobody names) is designed out: each
read returns the ids its writes take, and the descriptions say which tool yields them.

What authoring them once would take:

- **Authoring**: 74 `acquire` jobs against real test accounts, at the current bounds (4 attempts,
  400k tokens ceiling each, `GRAFT_ACQUIRE_*`), then a person reviewing each module and its
  description. Unleashed needs a trial account; its signing is already a keyring scheme
  (`unleashed_hmac`, `packages/proxy/src/schemes.ts`).
- **Sharing**: the toolbox is per person today: `authored_tool` is unique on
  `(person_id, vendor, name)` (`packages/db/src/schema/tool.ts`) and the working set, approvals and
  usage all key on `authored_tool.id`. A stock tool authored by Graft needs a home outside any
  person's toolbox and a way to run in a person's sandbox against their connection. Noted here,
  not designed (it is the map's "authored tools shared across persons" play, settled as the long
  run while charting).
- **Where the code lives**: tool modules that call a vendor's REST API with `ctx.fetch` carry no
  vendor client library, variable or id, so ADR 0002 as amended does not obviously bar them from
  the open repository; if they ship open, self-hosters get the same stock. Whether a vendor-named
  module counts as "a vendor in the open repository" is a question for that ADR's owner.
- **Upkeep**: an API change breaks a module; the eval harness (`packages/evals`) and the dry run
  are how drift is caught. 74 modules is a maintenance load a broker carries for you.
- **Connections**: a hosted person connects through Pipedream (relay) or the gateway; a self-hoster
  through the keyring with their own OAuth clients for Google, Slack and HubSpot. The stock tool
  is the same in both, because it runs through the proxy. This reverses GRA-220's "a stock tool
  comes from the connection's provider" for this source, which that note anticipated.

## Recommendation

1. **First source: Graft-authored stock, through the proxy, over any connection provider.** Author
   the ~74 basics with the loop, review them, and make them available to every person. It wins on
   terms, custody, self-host and vendor risk, matches ADR 0001's "Graft is the loop" (the stock is
   the loop's output, shown off), and covers Unleashed. Use the vendors' specs and remote-MCP tool
   lists as the authoring input for which basics to write and how to name them.
2. **Hosted breadth later: Pipedream actions behind the same seam**, for integrations beyond the
   authored set, only after Pipedream confirms in writing that listing, caching and showing action
   metadata to end users is permitted. Pipedream over a broker because the hosted connections are
   already Pipedream's, so there is no second connect step; Composio is the fallback if Pipedream
   says no (cheapest, broadest, but no token release and its own terms read).
3. **Not now**: vendors' remote MCP servers (two of eight usable), endpoint-as-tool from specs
   (the field abandoned it), Arcade, Nango, Merge, Paragon (terms, licence or custody), Klavis
   (abandoned; its Apache-2.0 servers are a reference, not a dependency).

The cost of (1) is the shared-tool mechanism and 74 authoring jobs with a review each (duration unmeasured); the cost of
starting with Pipedream instead is the prop translation (GRA-221), a terms answer Graft does not
have, ADR 0010 relaxed, and nothing for self-host.

## What could not be confirmed

- Whether a Google token Graft already holds works against Google's MCP servers, and whether a
  Slack user token from Graft's app works against Slack's (no authenticated call was made).
- Slack, Notion and HubSpot MCP tools' annotations and output schemas (no unauthenticated
  `tools/list`).
- Whether one HubSpot MCP Auth App can be installed across other customers' accounts.
- Pipedream's position on caching and displaying its catalogue (needs asking).
- Composio's Unleashed absence beyond two guessed slugs; Klavis's hosted terms and current pricing;
  Merge's catalogue-caching terms and its contradictory failed-call billing; Paragon's token access.
- HubSpot's "not intended for external use" wording (seen through a mirror, not the README).
- An Unleashed OpenAPI spec (a third-party site claims one; none found at the vendor).
- Latency of any source (no source publishes figures; none was measured here).
- How long authoring and reviewing 74 tools takes in practice; the per-job token cost of the
  current loop on these vendors.
