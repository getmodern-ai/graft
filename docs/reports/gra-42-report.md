# GRA-42 report (an elicitation accept without `allow` is an allow, for Hermes' approval buttons), PR #23

Saved by the orchestrator from the implementing agent's report, 2026-09-11. Branch `aleks/gra-42-elicitation-accept-tolerance`, SHA `9e9f1cf` (`1c271bf` code + tests, `9e9f1cf` docs). PR #23 against `main`; CI, Greptile (5/5, no comments, reviewed `9e9f1cf`) and CLA green; awaiting sebapoole. GRA-42 In Review.

## Where the validation happened and what changed

`@modelcontextprotocol/sdk` 1.30.0, `Server.elicitInput` (`dist/esm/server/index.js:356-367`): when `action === "accept"` and `content` is truthy (`{}` is), it runs Ajv over the content against `requestedSchema` and throws `McpError -32602` before Graft sees the result. Changes, all in `packages/mcp/src/approval.ts`:

- `elicitationSchemaFor`: `required: ["allow"]` removed; `allow`'s description ends "Accepting without this field counts as allow." `relax` unchanged (optional).
- New `readElicitationAnswer(result)`: `cancel` → null (nothing recorded); `decline` → deny; `accept` → allow unless content says `allow: false`. `askByElicitation` uses it; the try/catch fallback to the handoff is untouched, so any other mismatch (e.g. a string in `allow`) still throws in the SDK and falls back.
- Header paragraph naming Hermes 0.21.1; the destructive-tool message now reads "...asks before every call, whichever way you allow it here, until you relax it in the console."
- Docs: ADR 0006 consequences bullet; one paragraph in `skills/hermes-graft/SKILL.md`'s approval section.

## Mapping decision for Hermes' four buttons (from Hermes' source, `tools/approval_prompt.py`, `_consent()`)

`once`/`session`/`always` → `accept` with `content: {}`; `deny` → `decline`; no answer → `cancel`. So all three allow buttons are one `accept` to Graft and none maps to `relax`. A destructive tool asks before every call whatever button was pressed, until relaxed in the console; a write tool's yes holds by ADR 0008 even when the button said "once". Hermes keeps no memory on its elicitation path (CLI passes `allow_permanent=False`; the gateway path never persists the choice), so its card returns on every ask.

Observation, not acted on: Hermes fails closed to `decline` on its own internal errors (e.g. a missing gateway `notify_cb`), which Graft records as the person's standing deny on a write tool. Pre-existing; a follow-up candidate.

## Tests added (`approval.test.ts`, agent "Discord Hermes", SDK client over `InMemoryTransport`)

1. Empty accept on a write tool passes, records `allow`, holds; the schema's `required` no longer names `allow`.
2. `accept` + `{ allow: false }` still records `deny`, then `tool_denied`.
3. Empty accept on a destructive tool allows this call only, `perCallRelaxed: false`, next call asks again.
4. Empty accept on the build ask grants the build approval.
5. `{ allow: "yes" }` falls back to the handoff (`awaiting_approval`), records nothing; asserts the SDK's "requested schema" error on the warn.

Existing decline/cancel/relax cases unchanged. File: 22/22.

## Gate

`check` no fixes · `lint` exit 0 (two pre-existing warnings) · `check-types` 18/18 · `test --force` 18/18 `Cached: 0`, Postgres integration suite 8 passed via `TEST_DATABASE_URL` on 5440 with a throwaway database.

Not verified: the criterion over the real Discord gateway; the orchestrator rebuilds the live compose image after merge and retests the Allow Once button.
