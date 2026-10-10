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
- **`exchanges`** is every call the module made through the proxy, in the order the module issued
  them (numbered as each request reached the proxy, not as the vendor answered, so a module that
  reads with `Promise.all` records the order it asked in), in the dry run the build ran (the token
  carries the dry-run claim, so writes never left).
  - A **read** (`GET` or `HEAD`) carries the vendor `url` as it left the proxy, query included, and
    the vendor's `response`: the `status`, the `headers` kept (`content-type`, `location` and
    `link`, `RECORDED_RESPONSE_HEADERS`; every other is dropped), and the `body`.
  - A **write** (any other method) stopped at the proxy's preview and has no response: it carries
    the `url` the preview named and the `body` the module sent, if any.
- **A body** is exactly one of `{ "json": … }` (it parsed as JSON), `{ "text": "…" }` (UTF-8 that
  is not JSON) or `{ "base64": "…" }`. Absent for an empty body. `recordedBodyOf` and
  `recordedResponseOf` build them.
- **A JSON body is kept parsed, and served re-serialised** (`JSON.stringify`, no whitespace):
  parsed because the redaction walks it by key, which it cannot do in opaque text, and keeping the
  vendor's raw text beside it would keep whatever that walk removed. The build hands the module
  the re-serialised text while recording too, so recording and replay agree. **A stock module
  parses a JSON body** (`res.json()`) and does not compare, slice or search its text: the vendor's
  own formatting is not in the recording, and the nightly live run does not compare results. The
  build and the harness print a note (`jsonTextNotes`) for a module that calls `.text()` where the
  recording holds a JSON answer; it is a note, not a failure.
- **`result`** is the module's result in that run. Optional; when present a replay compares it
  whole.

Request headers are not recorded: the proxy injects the credential, and the module's own headers
are its code, which the reviewer reads.

## Redaction

A recording is written through `redactRecording(recording, rule)`, the acquire trace's redaction
(`@graft/core`'s `redactValue`) with one addition:

- **By value**: every value in `rule.secretValues` is replaced wherever it appears, in a URL, a
  header or a body. The build command passes every form of the connection's credential fields,
  which it holds (`src/secrets.ts`'s `credentialForms`): each value as it is, percent-encoded,
  form-encoded, base64 and base64url, `Bearer <value>`, and for `basic` the `username:password`
  pair in each of those encodings and as `Basic <pair>`, so a vendor echoing the header's bare
  base64 under a field of any name is still caught. The command's printed sentences go through
  the same values.
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

## The replay

`proveReplay` (`src/harness.ts`) runs the module as a dry run, by the real runner through the real
proxy, over a connection whose hosts are the manifest's `hosts`, so a call to an undeclared host is
the proxy's `host_not_in_set`. The proxy's vendor is the recording:

- each read must be a recorded read not yet made: the first, in the order of issue, with its
  method, host, path and query (as a set of parameters), so parallel reads that reach the proxy
  in another order still find their own; the vendor answers it with the recorded response;
- every write stops at the preview and never reaches the vendor; the previews, in the order the
  module issued them, must be the recording's writes in order, method, host, path and body;
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
