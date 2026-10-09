# The stock recording format

Every stock tool carries `recording.json` beside its module: what its proof saw when it was built,
so the harness can replay it on every pull request with no secret and no vendor reached (ADR 0025;
GRA-240). The build command (GRA-246) writes it; a reviewer reads it. `src/recording.ts` is this
format as code, and `parseRecording` is the reader the harness uses.

The recording is the harness's, not the tool's: `readStockWorkspace` leaves it out of the module's
files and out of the source hash, so re-recording a tool appends no catalogue version and nothing
of it reaches a person's toolbox.

## Shape

```json
{
  "format": 1,
  "tool": "open-meteo__current-weather",
  "recordedAt": "2026-10-09T08:42:31Z",
  "input": { "city": "Melbourne" },
  "exchanges": [
    {
      "kind": "read",
      "method": "GET",
      "url": "https://geocoding-api.open-meteo.com/v1/search?name=Melbourne&count=1&format=json",
      "response": {
        "status": 200,
        "headers": { "content-type": "application/json; charset=utf-8" },
        "body": { "json": { "results": [] } }
      }
    },
    {
      "kind": "write",
      "method": "POST",
      "url": "https://api.example.com/v1/notes",
      "body": { "json": { "text": "hello" } }
    }
  ],
  "result": { "found": true }
}
```

- **`format`** is `1`. A reader refuses any other with a sentence naming the file.
- **`tool`** is the wire name, `<vendor>__<name>`, and must be the directory's.
- **`recordedAt`** is ISO 8601.
- **`input`** is the input the proof ran with, and must equal `test-input.json`; a changed test
  input means a rebuild.
- **`exchanges`** is every call the module made through the proxy, in order, in the dry run the
  build ran (the token carries the dry-run claim, so writes never left).
  - A **read** (`GET` or `HEAD`) carries the vendor `url` as it left the proxy, query included, and
    the vendor's `response`: the `status`, the `headers` kept (`content-type`, `location` and
    `link`, `RECORDED_RESPONSE_HEADERS`; every other is dropped), and the `body`.
  - A **write** (any other method) stopped at the proxy's preview and has no response: it carries
    the `url` the preview named and the `body` the module sent, if any.
- **A body** is exactly one of `{ "json": … }` (it parsed as JSON), `{ "text": "…" }` (UTF-8 that
  is not JSON) or `{ "base64": "…" }`. Absent for an empty body. `recordedBodyOf` and
  `recordedResponseOf` build them.
- **`result`** is the module's result in that run. Optional; when present a replay compares it
  whole.

Request headers are not recorded: the proxy injects the credential, and the module's own headers
are its code, which the reviewer reads.

## Redaction

A recording is written through `redactRecording(recording, rule)`, the acquire trace's redaction
(`@graft/core`'s `redactValue`) with one addition:

- **By value**: every value in `rule.secretValues` is replaced wherever it appears, in a URL, a
  header or a body. The build command passes the connection's credential fields, which it holds.
- **By shape**: bearer and basic credentials, JWTs, and the well-known key shapes.
- **By field name inside a string**: `api_key=…` in a query, `token: …` in prose, over the generic
  names and `rule.secretFieldNames` (the scheme's fields, from `secretFieldNamesFor`).
- **By JSON key**: a property whose key is one of those names has its string value replaced, since a
  parsed body has no `name: value` text for the field pass to read. Keys are kept, so a reader sees
  which field held a secret.

A query parameter the scheme carries the key in is therefore recorded as `[redacted]` or the
proxy's `[redacted:credential]`; a replay sets a parameter recorded with a redacted value aside on
both sides, since the replay's connection holds no key.

The build command records through `src/record.ts`'s `recordStockProof`, which first mirrors the
proxy's own echo redaction (`@graft/proxy`'s `echo.ts`): a credential value the vendor echoed in a
text body or a kept header is recorded as `[redacted:credential]`, which is what the module saw, so
the replay hands the module the same text and gets the recorded result.

The harness fails a tool whose committed recording is not a fixed point of `redactRecording` with
no rule: anything credential-shaped left in it is a recording that was not written through it.

## The scrub

**A recording the build command writes never holds real data** (GRA-257). Stock tools are built
against a maintainer's own account and the repository is public, so before anything is written
every value the vendor answered is replaced by a placeholder, and the test input with it.
`src/scrub.ts` is the rule; `recordStockProof` applies it on every recording, and there is no flag
to keep the values.

- **Every string and number** in a response body, in the kept headers but `content-type`, and in
  the input becomes a placeholder of the same type and shape: an email stays an email (its local
  part redrawn, at `example.com`); an ISO date or time stays one, in the same layout; a URL keeps
  its scheme and host and loses its path and query (inside a `link` header too); any other string
  keeps its length, its punctuation and spaces, each letter a letter of the same case and each digit
  a digit (an id stays id-like, a hex id hex); a number keeps its sign, its digit counts and its
  decimal places. A text body is one string; a binary body becomes the same number of drawn bytes.
- **Keys, array lengths and nesting are kept**, and so are booleans and `null` (one bit, and the
  bit a module branches on), the integers 0 to 99 (counts, pages and codes a module loops on), a
  redaction marker, and a string with no letter or digit.
- **A value the module's code spells is kept**: every string literal in its files, and every string
  in its input schema (`keptLiteralsOf`). They are public already, and a module comparing an answer
  with `"message"` must still find it. An input value that must reach a live vendor as it is (a
  city) survives the scrub by being the schema's `default`, an `examples` entry or an `enum` value.
- **One value is one placeholder** across the whole recording, so an id one answer gave and a later
  request names is the same placeholder in both. Placeholders are drawn from a random seed per
  recording, so one is not a keyed hash of a guessable name.
- **The requests and the result are the module's own over the scrubbed answers.** After the scrub
  the module runs again as a dry run whose vendor is the scrubbed answers in order, and the URLs it
  asks for, the write bodies the proxy previews and the result it answers there are what is
  recorded. A request built from an earlier answer, or a result the module computed (a name
  upper-cased, two fields joined), is therefore the scrubbed data's, and the replay matches by
  construction. A module that behaves differently over the scrubbed answers (a different number of
  reads, a failed run) fails the recording, and nothing is written.
- **The last check** (`survivingValuesOf`) looks for every string of six characters or more from
  the raw input and answers in what is about to be written, setting aside the module's own text and
  the keys; a survivor fails the recording, naming where it was and never the value.

`test-input.json` is the recording's scrubbed input, since the two must be equal. One consequence for
live mode: a scrubbed test input names nothing in any real account, so a tool whose input matters
(an id, a name to search for) answers differently live than recorded unless its input survives as
a schema value. The hand-made Open-Meteo recording predates the scrub and holds a public API's
answers about a city, which is no one's data.

## The replay

`proveReplay` (`src/harness.ts`) runs the module as a dry run, by the real runner through the real
proxy, over a connection whose hosts are the manifest's `hosts`, so a call to an undeclared host is
the proxy's `host_not_in_set`. The proxy's vendor is the recording:

- each read must be the recording's next read: method, host, path and query (as a set of
  parameters); the vendor answers it with the recorded response;
- every write stops at the preview and never reaches the vendor; the previews must be the
  recording's writes in order, method, host, path and body;
- every recorded read must have been made, the dry run must pass, and the result must be the
  recording's.

Each failure is a sentence opening `stock tool <vendor>__<name>:` and naming the cause.

## Live mode

`GRAFT_STOCK_LIVE=1 pnpm --filter @graft/stock test:live` sends the same dry run's reads to the
vendor instead (`src/mode.ts`). The connection for each keyed vendor comes from
`GRAFT_STOCK_LIVE_CONNECTIONS`, a JSON object keyed by vendor slug:
`{ "<vendor>": { "scheme", "schemeConfig"?, "credential", "primaryHost"? } }`; a keyless starter
needs none. `GRAFT_STOCK_TOOLS` (comma-separated wire names) narrows either mode. Live, a read must
match the recording's method, host, path and query parameter names (values may follow the vendor's
data), the vendor's status must be the recorded one, and every key path of a recorded JSON body
must still be in the vendor's; the result and write bodies are not compared. This is the nightly
drift check's engine (GRA-247). `pnpm run test` never goes live: Turbo's strict env mode withholds
the variables.
