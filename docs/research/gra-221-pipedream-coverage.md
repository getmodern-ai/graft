# How much of Pipedream's catalogue for the starter integrations is usable as stock tools? (GRA-221)

Research for the wayfinder map GRA-220. Read 2026-10-06. Terms follow `CONTEXT.md`: a **stock tool**
is what a **tool source** offers for a connection; *action* is only Pipedream's word for its
components, used here when talking about Pipedream's source.

## Sources

- `PipedreamHQ/pipedream` at `19a02750f24ccff09da19d27ac0b6bb6b8478bfc` (master, 2026-10-05), a
  shallow sparse clone, read only, **no code of it run**. Directories read:
  `components/{gmail,google_calendar,google_drive,slack_v2,notion,github,hubspot,unleashed_software}`
  (each `actions/`, `common/` and the `*.app.mjs`), `.github/pipedream-component-guidelines.md`,
  `.github/pipedream-action-guidelines.md`, `scripts/tool-annotations/`,
  `packages/sdk/src/shared/component.ts`.
- Pipedream's docs, fetched 2026-10-06: Connect API reference *List actions*, *Retrieve action*,
  *Run action*, *Configure action prop*, *Reload action props*; *Connect / Components / Actions*;
  *MCP / Tool modes* (`pipedream.com/docs/connect/...`).
- Graft: `packages/mcp/src/tools/find-tool.match.ts` (the search rule tested below),
  `packages/core/src/setup/starter-vendors.ts` (the starters).

Slack is `slack_v2` in the registry; there is no `components/slack` at this commit (graft-cloud's
catalogue already resolves the starter `slack` to `slack_v2`). Unleashed is `unleashed_software`.

## Method

The component files are ES modules whose props are spread from `common/` modules and from the app
file's `propDefinitions`. A static reader (`@babel/parser`, a few hundred lines kept outside the
repository) evaluated each action's default export as data: object and array literals, spreads,
imports between local files, `const` and destructuring bindings, `propDefinition: [app, "name"]`
merged with the action's overrides. Functions were recorded as functions, never called. Nine props
in five actions the reader could not resolve (a props factory, an `Object.fromEntries` map,
generated optional Block Kit props, a second app) were read by hand and are folded into the
figures below.

A required prop is one with `optional` not `true`, no `default`, not `hidden`/`disabled`, and not
the `app` prop. A prop needs **remote options** when its `options` is a function (`async options`);
the Connect API marks those `remoteOptions: true` and fills them through `configureComponent`
(SDK `component.ts`; API reference, `ConfigurablePropBase.remoteOptions`).

Each action is put in one of three tiers:

- **One call**: no required prop with remote options, no `reloadProps` on a required prop, no
  `additionalProps()`, one app. Runs from a flat JSON input.
- **One call given an id**: the only obstacle is a required remote-options prop, every one of which
  is an id or a slug typed `string`/`string[]`/`integer`. Pipedream's own MCP server exposes such a
  prop as a plain `"type": "string"` and points at `CONFIGURE_COMPONENT` in the description (*Tool
  modes*, the `google_sheets-add-single-row` schema), so a caller that already holds the id can pass
  it. The model needs it from somewhere: another stock tool, the person, or an earlier result.
- **Dynamic**: `additionalProps()` or a required `reloadProps`, or a second app. The input shape is
  not known until a configure/reload round trip; not usable as a fixed `inputSchema`.

"Asks" applies Graft's grain (ADR 0008 as amended 2026-09-15): reads never ask, everything else asks
once per agent. A stock tool asks unless `readOnlyHint: true`; a missing annotation would ask.

## The table

| Integration (Pipedream app) | Actions | One call | + given an id | Dynamic | `readOnlyHint: true` | Would ask | Annotations missing | Read-only but writes | `ai: "optimized"` | Median description |
|---|---|---|---|---|---|---|---|---|---|---|
| Gmail (`gmail`) | 16 | 14 | 1 | 1 | 9 | 7 (44%) | 0 | 0 | 11 | 554 chars |
| Google Calendar (`google_calendar`) | 17 | 10 | 6 | 1 | 9 | 8 (47%) | 0 | 0 | 7 | 176 |
| Google Drive (`google_drive`) | 50 | 26 | 22 | 2 | 23 | 27 (54%) | 0 | 0 | 47 | 171 |
| Slack (`slack_v2`) | 52 | 52 | 0 | 0 | 26 | 26 (50%) | 0 | **2** | 52 | 382 |
| Notion (`notion`) | 25 | 18 | 7 | 0 | 11 | 14 (56%) | 0 | 0 | 15 | 399 |
| GitHub (`github`) | 48 | 37 | 9 | 2 | 29 | 19 (40%) | 0 | 0 | 30 | 436 |
| HubSpot (`hubspot`) | 108 | 52 | 56 | 0 | 56 | 52 (48%) | 0 | **1** | 54 | 229 |
| Unleashed (`unleashed_software`) | 16 | 7 | 7 | 2 | 10 | 6 (38%) | 0 | 0 | 0 | 97 |
| **All eight** | **332** | **216 (65%)** | **108 (33%)** | **8 (2%)** | 173 | 159 (48%) | 0 | 3 | 216 | |

The dynamic eight: Gmail *Update Signature for Email in Organization* (needs a second app,
`google_cloud`, for a service account); Calendar *Update Following Event Instances*
(`additionalProps`); Drive *Add File Sharing Preference* and *Remove File Sharing Permission*
(`reloadProps` + `additionalProps`); GitHub *Get Reviewers* and *List Gists for a User*
(`additionalProps`); Unleashed *Create Purchase Order* and *Create Sales Order* (line items through
`reloadProps: numLineItems` + `additionalProps`).

### Which common basics fall outside one call

| Integration | Basics in one call | Basics that need an id first (remote-options prop) |
|---|---|---|
| Gmail | Send Email, Find Emails (search), Get Thread, Create Draft, List Labels, Modify Labels, Download Attachment | Get Send As Alias |
| Google Calendar | List Events, Create Event, Add Quick Event, List Calendars, Get Calendar, Query Free/Busy | **Get Event, Update Event, Delete an Event**, Add Attendees, List Event Instances (`eventId`, no lister names it) |
| Google Drive | List Files, Search Files, Find File/Folder, Get File, Upload File, Create Folder, Create File From Text, Download File | Get File By ID, **Update File**, Copy/Move/Trash/Delete File, every comment and reply action (`fileId`, and `drive` made required with a hidden sentinel value `My Drive`) |
| Slack | All 52, including Post Message, Send Message, List Channels, Find User by Email, Search, Get Channel History | none (the `ai: "optimized"` rewrite removed every `async options` from `slack_v2.app.mjs`: 0 left) |
| Notion | Search, Retrieve Page, Create Page, Update Page, Query Data Source, Append Block, List All Users | Retrieve User, Retrieve Database Content (`dataSourceId`), Duplicate Page, Retrieve Page Property Item |
| GitHub | Create/Get/Update Issue, Search Issues and Pull Requests, Create/Get/Update Pull Request, List Commits, List Repositories, List Branches | List Releases, List Organization Repositories, workflow dispatch/enable/disable, Update Gist, Get Issue Assignees, Update Project V2 Item Status |
| HubSpot | Search CRM, Search CRM Objects, Get CRM Objects (batch read by id), Create CRM Object, Update CRM Object, Create Company, Create or Update Contact, Create Note/Task, List Owners, List Pipelines and Stages | **Get Contact, Get Company, Get Deal, Update Contact/Company/Deal** (`objectId`, `useQuery`), **Create Deal** and Create Ticket (pipeline and stage), Add Note to Contact, Add Contact to List, Create Lead, Send Message |
| Unleashed | only the seven `List … ID Options` | **every real basic**: Get Sales Order, Get Purchase Order, Get Stock On Hand, Update Sales/Purchase Order, Create Stock Adjustment/Transfer; there is no list or search of sales orders, products or customers other than the `… ID Options` listers |

HubSpot's per-object basics are outside, but its generic ones (*Search CRM*, *Get CRM Objects*,
*Create/Update CRM Object*) are inside and cover the same objects, so HubSpot is usable through four
tools. The `List … Options` actions (25 across the eight) are Pipedream turning a prop's
`async options` into a tool: Unleashed's call `propDefinitions.productId.options` directly and
return `{ label, value }` pairs. Of the 168 required remote-options props, only 5 name a stock tool
that would yield the id in their description (one in Drive, four in HubSpot); the other 163 say
"Select a …" or "The ID of a …".

## Annotations

- **Present on every one of the 332**, all three hints. The repository's ESLint enforces presence
  and the guidelines give a decision table (fetch/list/search/get read-only; create/send/update
  not; delete destructive). The first pass was machine-written: `scripts/tool-annotations/`
  applies annotation CSVs named `registry-actions-claude-2025-09-29.csv` and
  `registry-action-chatgpt-2025-09-25.csv`; reviewers check semantics since.
- **Read-only but writes** (found by reading each read-only action's `run` and every method it
  reaches, for HTTP verbs and SDK write calls, then checking the hits by hand):
  - Slack *Get File* and *List Files*: `readOnlyHint: true`, but the `addToChannel` prop defaults to
    `true` and `run` calls `maybeAddAppToChannels`, which calls `conversations.invite` to add the
    bot to the channel (`slack_v2.app.mjs`, `inviteToConversation`). A read that joins a channel.
  - HubSpot *Search CRM*: `readOnlyHint: true`, with `createIfNotFound` and `creationProps` that
    create the object when nothing matched (`createObject`). Off by default, but a model can set it
    and Graft's gate would never ask.
  - The rest of the 173 checked clean. HubSpot's read-only actions that `POST` call search and
    `batch/read` endpoints; Gmail's and Slack's downloads write only to the run's `/tmp`.
- **Write-annotated reads** (over-asking, harmless): Drive *Download File* (writes `/tmp`), Notion
  *Retrieve File Upload*, HubSpot *Retrieve Migrated Workflow Mappings*.
- **Share that would ask**: 159 of 332 (48%); per integration 38% to 56%. For the one-call tier
  alone it is 89 of 216 (41%).
- A tool source cannot trust `readOnlyHint` for a tool whose input can flip it into a write. The
  three above are the ones in these eight; a per-key override list beside the source is enough at
  this size.

## From `configurable_props` to `inputSchema`

Prop types seen across the 332 (1,692 props resolved): `string` 932 (275 with remote options, 107 with
static options), `boolean` 157, `integer` 108 (8 remote), `string[]` 83 (18 remote, 8 static),
`object` 55, `alert` 16, `dir` 9, `app` 332 (one per action, plus Gmail's `google_cloud`). None of
`any`, `sql`, `integer[]`, `http_request`, `$.airtable.*`, `$.discord.*`, `$.interface.*`,
`$.service.db` occurs in these eight. The API's types are in the *List actions* reference
(`ConfigurableProp*`) and the SDK's `component.ts`.

| Prop | `inputSchema` rule | Clean? |
|---|---|---|
| `app` | Drop. The source binds the connection's account (`authProvisionId`) at run. | yes |
| `string` | `{ "type": "string" }`; `label` → `title`, `description` → `description`. | yes |
| `string` + static `options` | `enum` of the values; labels into the description, or `oneOf` of `{ const, title }`. | yes |
| `string` + `async options` (`remoteOptions`) | `{ "type": "string" }` with the description; say where the id comes from. `useQuery` changes nothing for the schema. | the shape yes, the value no (see tiers) |
| `withLabel: true` | The run reads `.value` of the prop (HubSpot *Add Contact to List*: `listId: list.value`), so a bare string breaks it. Wrap a string into `{ __lv: { label: v, value: v } }` on the way in, or expose `{ label, value }`. | needs a wrapper |
| `secret: true` | `{ "type": "string", "writeOnly": true }`; never log it. Only Slack *Verify Slack Signature*. | yes |
| `format: "file-ref"` | `{ "type": "string" }`, "a URL or a `/tmp` path" (*List actions*, `ConfigurablePropStringFormat`). Six props: Gmail attachments, Drive upload/update, Slack upload, Notion file upload. A Graft `blob://` ref resolves to neither, so a file must be made reachable by URL first. | no, for blobs |
| `string[]` | `{ "type": "array", "items": { "type": "string" } }`; static options → `items.enum`. 31 `string`/`string[]` props take JSON text inside the string (Slack blocks, Notion properties, HubSpot): the schema says string, the description says JSON. | shape yes, content by description |
| `integer` | `{ "type": "integer", "minimum": min, "maximum": max }`; static options → `enum`. | yes |
| `integer[]` | array of integer. | yes (absent here) |
| `boolean` | `{ "type": "boolean" }`. | yes |
| `object` | `{ "type": "object", "additionalProperties": true }`. The keys are the vendor's (HubSpot `objectProperties`, 16 of the 18 required ones) and live only in the description. | shape yes, keys no |
| `any` | `{}`. Nothing to tell a model. | no (absent here) |
| `alert` | Drop from the schema; append `content` to the tool's description. These 16 carry usage notes ("permanently deletes", "use Find File to get an id"). | yes, as description |
| `dir` | Drop from the schema; it is the run's File Stash. Pass `stash_id` on *Run action* (`true`/`"NEW"`) when the action reads or writes files; three have it required (Gmail *Download Attachment*, Slack *Download File*, Notion *Send File Upload*). | yes, as a run option |
| `sql` | Needs a `configureComponent` call for the schema, and its value is `{ app, query, params }`. | no (absent here) |
| `$.<app>.<x>` (Airtable, Discord) | Typed ids resolved against another prop through the configure API. | no (absent here) |
| `http_request` | A whole request object. | no (absent here) |
| `hidden` / `disabled` | Drop. | yes |
| `default` | JSON Schema `default`, and not `required`. | yes |
| `optional` absent or `false`, no default | Into `required`. | yes |
| `reloadProps` / `additionalProps()` | No fixed schema. Exclude the tool, or snapshot the props after a reload with chosen inputs and treat that as a separate tool. | no |

### What `ai: "optimized"` changes

It is a top-level property on an action's default export, required on "every action that is
created or modified" (`.github/pipedream-component-guidelines.md`, "`ai: "optimized"`"); it
replaced a `// x-pd-ai: optimized` comment. It is **not in the API**: no field of *List actions* or
*Retrieve action* carries it, so a tool source sees it only in the source. Nothing in the clone reads
it. It marks an action rewritten to the agent-facing guidelines, and the difference is measurable
(216 marked, 116 not):

| | `ai: "optimized"` | not |
|---|---|---|
| Mean description length | 460 chars | 151 chars |
| Description names another tool in bold ("Use **List Channels** …") | 57% | 3% |
| Prop descriptions with an example (`e.g.`, a backticked value) | 57% | 10% |
| Props with `async options` | 19% | 28% |
| Actions with no required remote-options prop | 75% | 49% |

Slack is the clearest case: all 52 marked, `async options` removed from the app file entirely,
each id prop's description naming the lister ("**Prefer a channel ID** … use **List Channels**").
Unleashed has none marked and one-line descriptions. Read it as a quality signal for ranking or
for choosing which integrations to offer, not as a behavioural switch.

## Search: `find_tool`'s all-words rule against these names

`find_tool` lowercases the query, splits on non-alphanumerics, drops one-character words and
requires every word as a substring of `vendor name description`, ranking name hits first
(`find-tool.match.ts`). Run over the 332 with the Graft vendor slug as `vendor`:

| Query | Hits | Ranked first | Right tool? |
|---|---|---|---|
| HubSpot "find a contact" | 1 | Create CRM Object | **no**: a write, matched because its description says "find"; *Search CRM* ("Search a CRM object type by a single property") is missed |
| HubSpot "search contacts" | 4 | Search CRM Objects | yes |
| HubSpot "get contact" | 9 | Get Contact | needs an id |
| Gmail "send email" | 5 | Send Email | yes |
| Gmail "read email" | 8 | Find Emails | acceptable |
| Google Calendar "list events" | 5 | List Events | yes |
| Google Calendar "upcoming events" | 1 | Respond to Event Invitation | **no** |
| Google Calendar "schedule meeting" | 0 | | **no** (Create Event) |
| Google Drive "list files" | 7 | List Files | yes |
| Slack "send message" | 10 | Build and Send a Block Kit Message | weak: Post Message, the one the descriptions recommend, is not in the top four |
| Slack "send dm" | 0 | | **no** (Send Message to User or Group) |
| Notion "search pages" | 2 | Search | yes |
| GitHub "list issues" | 5 | List Milestones | **no**: there is no list-issues tool; *Search Issues and Pull Requests* lacks the word "list" |
| GitHub "list pull requests" | 3 | Get Pull Request | **no** (same) |
| Unleashed "list products" / "find customer" / "list sales orders" | 0 | | **no** ("List Product ID Options" exists; nothing lists orders) |

So: "send email" and "list events" work; "find a contact" does not, and returns a write. The rule
is fine for names that echo the query and fails on synonyms (find/search/get, list/search,
dm/direct message), plurals against singular names, and generic tools whose object is a prop value
(HubSpot's CRM object type, whose `options` list *contacts*).

What would: a ranked, not all-or-nothing, match over more fields. (1) Normalise: stem plurals,
drop stop words ("a", "an", "the", "my"; today "an" is a substring of most descriptions).
(2) A small verb-synonym table (find ↔ search/get/lookup, list ↔ search/query/browse,
send ↔ post/message, create ↔ add/new). (3) Index prop labels and static option labels as well as
name and description, so *Search CRM* is reachable by "contact". (4) Score by matched concepts,
name weighted over description, read-only above writes when the query's verb is a read; keep
today's all-words hits as the first tier. A sketch of (1), (2) and (4) moved "send dm", "list
issues", "list pull requests" and "list products" to the right first hit, but still ranked
*Get Contact* (an id lookup) over *Search CRM* for "find a contact" without (3). (5) Past that,
embeddings over name + description, which the evals could judge, or a short per-tool alias list
the source carries ("find contact" → *Search CRM*).

## The answer

- **About two thirds run in one call** (216 of 332), and **98% run in one call once the model has
  an id** (324). Only 8 need Pipedream's configure/reload round trip and cannot be a fixed schema.
  Slack is 52 of 52; Gmail, GitHub and Notion are mostly clean; HubSpot is clean through its
  generic CRM tools; Google Calendar and Drive keep `eventId`/`fileId` behind remote options with no
  description saying where to get one; **Unleashed is barely usable**: only its seven
  `List … ID Options` run in one call, there is no list or search of orders, products or customers,
  and its two creates take line items through `additionalProps`.
- **Annotations are present everywhere and mostly right**; three read-only tools can write (Slack
  *Get File*, *List Files* by default, HubSpot *Search CRM* on request). About half (48%) would ask.
- **Translation is mechanical for every type present** except `withLabel` (wrap), `file-ref`
  (a URL, not a blob), `object` and JSON-in-string (keys only in prose), and the dynamic tier.
- **Search needs work**: the current all-words match finds "send email" and "list events" and
  misses "find a contact" (returning a write instead).
