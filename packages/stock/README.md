# The stock workspace

Graft's **stock tools** (ADR 0025): the basics of each starter integration, authored once by
Graft's own `acquire` loop, reviewed, and shipped with the server. One directory per tool,
`tools/<vendor>/<name>/`:

- the module (`index.ts` and anything beside it; no `package.json`, a stock tool calls its vendor
  through `ctx.fetch` alone);
- `manifest.json`: the name, the description, the input schema, the hosts it calls and the
  annotations the check derives;
- `test-input.json`: the input its proof runs with;
- `recording.json`: the proof as it was recorded at build time (`RECORDING.md`).

The boot loads the workspace into the global catalogue (`src/workspace.ts`); a tool whose files
changed is appended as its next catalogue version, and no version is ever edited.
`src/harness.test.ts` is the harness every tool passes on every pull request, with no secret:
the check, the test input, and the replay of the recording through the real proxy.
`pnpm --filter @graft/stock test:live` runs the same replay against the vendors (`RECORDING.md`,
*Live mode*). Stock tools are maintainer-built for now (`CONTRIBUTING.md`).

## Building a stock tool

The build command runs the real `acquire` loop in-process, as you, against your own connection of
the integration, and writes the tool directory here (GRA-246; the command is
`packages/stock-build`):

```bash
pnpm --filter @graft/stock-build build-tool -- <vendor> "<goal>"
pnpm --filter @graft/stock-build build-tool -- hubspot "Find a contact by email address"
pnpm --filter @graft/stock-build build-tool -- github "List my open pull requests" --hints "Use the search endpoint."
```

- **`<vendor>`** is a starter integration's slug (`@graft/core`'s `setup/starter-vendors.ts`).
  The model is told the starter's documentation URL and the rules a stock tool lives under, beside
  your `--hints`.
- **On success** it writes the module, `manifest.json`, `test-input.json` and `recording.json` into
  `tools/<vendor>/<name>/`, where `<name>` is the one the model chose. The files are formatted
  with the repository's Biome first, then copied into a `.build-*` directory in the workspace and
  must pass the harness's three proofs there as they stand, which is what CI runs; only then are
  they renamed into place. Then read the module and the recording (the build prints a note where
  the module reads a JSON answer as text; `RECORDING.md`), run `pnpm run lint` and
  `pnpm --filter @graft/stock test` as a reviewer will, and open a pull request.
- **A failed job writes nothing.** It prints the job's failure, its message and its last
  diagnostics, and exits 1. So does a goal `acquire` would refuse, a draft that declares a package,
  a proof that cannot be recorded, a tool that does not pass the harness, and a copy that fails.
- **A repair is `--from <name>`**: the current module, its manifest and its test input are the
  model's starting point, and the result is written in place of the current version, under the
  current name whatever the draft calls itself. The current version is set aside only once the
  new one has passed beside it, and put back if the move fails, so a failed repair leaves it as
  it was. The next boot appends the new one to the catalogue as the next version. Without
  `--from`, a tool that already exists is refused and nothing is written.
- **`--attempts <n>`** caps the job's attempts (default 4); the token ceiling is the server's
  default, 400,000.

### What it needs

Both from the environment, then `packages/stock-build/.env`, then `apps/server/.env`. Every
`.env` is ignored by git; **never commit a credential**, and keep these out of every file that is
tracked.

- **A model**, as the server reads one: `GRAFT_MODEL_BACKEND=provider` with `GRAFT_MODEL_PROVIDER`
  (`anthropic` or `openai`) and `GRAFT_MODEL_API_KEY` (and optionally `GRAFT_MODEL_AUTHORING`,
  `GRAFT_MODEL_TRIAGE`, `GRAFT_MODEL_BASE_URL`), or `GRAFT_MODEL_BACKEND=scripted` with
  `GRAFT_MODEL_SCRIPT=<file>` for canned answers (`@graft/model`'s `parseScript` has the shape).
- **Your connection**, for every starter that takes a key: `GRAFT_STOCK_LIVE_CONNECTIONS`, the
  variable the live harness reads, a JSON object keyed by vendor slug:

  ```bash
  GRAFT_STOCK_LIVE_CONNECTIONS='{"github":{"scheme":"bearer","credential":{"token":"…"}},"hubspot":{"scheme":"bearer","credential":{"token":"…"}}}'
  ```

  `scheme` is one of the proxy's schemes and `credential` its fields; `schemeConfig` and
  `primaryHost` are optional. For an OAuth integration (Gmail, Google Calendar, Google Drive,
  Slack, Notion), give a current access token under `bearer`. Your own account will do while
  Graft's test accounts are parked (GRA-235): the recording is scrubbed of every value the vendor
  answered before it is written (`RECORDING.md`, *The scrub*), and so is the test input. The model
  does read your data during the job, as `acquire` always does, so use an account whose data may go
  to the model's provider. Open-Meteo needs none.

### What it touches, and what it does not

The job runs in this process: the MCP session, the job and its runner, the check, the publish and
the proxy are the real ones; the database is held in memory, the toolbox is a temporary directory,
and both are thrown away at the end. **It never writes to a person's toolbox or to any database,
hosted or local**, and its only output is the tool directory here.

The proxy injects your credential on each call and is the only route to the vendor: reads reach
it for real, as the documentation reads do, and **every write stops at the proxy's preview**, in
the job's dry runs and in the recording alike, so nothing changes in your account. The credential
never reaches the model or a file: the recording is written only through `redactRecording` with
your credential's values (`RECORDING.md`, *Redaction*), and the failure the command prints is
redacted the same way. Nothing your account holds reaches a file either: the recording and the test
input are scrubbed, always, with no flag to keep the values (`RECORDING.md`, *The scrub*). Read the
recording before you commit it all the same; a URL keeps its host.

The module runs on the **fake sandbox backing**, a child process on your machine, as
`GRAFT_SANDBOX_BACKEND=fake` does for the server on a laptop: it is not a sandbox, so run the
command only for integrations whose documentation you trust the model to read.
