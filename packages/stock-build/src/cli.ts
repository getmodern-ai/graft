import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  createProviderModel,
  createScriptedModel,
  MODEL_PROVIDERS,
  type ModelAdapter,
  type ModelProviderName,
  parseScript,
} from "@graft/model";
import { liveConnectionsFrom } from "@graft/stock/mode";
import dotenv from "dotenv";

import { buildStockTool } from "./build";

/**
 * The stock build command (GRA-246; `packages/stock/README.md` is the maintainer's page):
 *
 *   pnpm --filter @graft/stock-build build-tool -- <vendor> "<goal>" [--from <name>] [--hints "<text>"]
 *
 * The model is `GRAFT_MODEL_BACKEND` as the server reads it (`provider` with `GRAFT_MODEL_PROVIDER`
 * and `GRAFT_MODEL_API_KEY`, or `scripted` with `GRAFT_MODEL_SCRIPT`); the maintainer's connection
 * is `GRAFT_STOCK_LIVE_CONNECTIONS`, the variable the live harness reads. Both come from the
 * environment, then `packages/stock-build/.env`, then `apps/server/.env`; every `.env` is ignored
 * by git. Exit 0 when the tool was written, 1 when nothing was, 2 for a usage error.
 */

for (const path of ["../.env", "../../../apps/server/.env"]) {
  dotenv.config({ path: fileURLToPath(new URL(path, import.meta.url)), quiet: true });
}

const USAGE =
  'Usage: pnpm --filter @graft/stock-build build-tool -- <vendor> "<goal>" [--from <name>] [--hints "<text>"] [--attempts <n>]';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  allowPositionals: true,
  options: {
    from: { type: "string" },
    hints: { type: "string" },
    attempts: { type: "string", default: "4" },
  },
});

const [vendor, goal, ...rest] = positionals;
if (!vendor || !goal || rest.length > 0) {
  console.error(USAGE);
  process.exit(2);
}
const maxAttempts = Number(values.attempts);
if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
  console.error(`--attempts must be a whole number of at least 1, not ${values.attempts}`);
  process.exit(2);
}

async function modelFromEnvironment(): Promise<ModelAdapter | string> {
  const env = process.env;
  if (env.GRAFT_MODEL_BACKEND === "scripted") {
    if (!env.GRAFT_MODEL_SCRIPT) return "GRAFT_MODEL_BACKEND=scripted needs GRAFT_MODEL_SCRIPT.";
    return createScriptedModel(
      parseScript(JSON.parse(await readFile(env.GRAFT_MODEL_SCRIPT, "utf8"))),
    );
  }
  const provider = env.GRAFT_MODEL_PROVIDER;
  if (
    env.GRAFT_MODEL_BACKEND === "provider" &&
    MODEL_PROVIDERS.includes(provider as ModelProviderName) &&
    env.GRAFT_MODEL_API_KEY
  ) {
    return createProviderModel({
      provider: provider as ModelProviderName,
      apiKey: env.GRAFT_MODEL_API_KEY,
      authoringModel: env.GRAFT_MODEL_AUTHORING ?? null,
      triageModel: env.GRAFT_MODEL_TRIAGE ?? null,
      baseUrl: env.GRAFT_MODEL_BASE_URL ?? null,
    });
  }
  return "The build needs a model: GRAFT_MODEL_BACKEND=provider with GRAFT_MODEL_PROVIDER (anthropic or openai) and GRAFT_MODEL_API_KEY, or GRAFT_MODEL_BACKEND=scripted with GRAFT_MODEL_SCRIPT.";
}

const model = await modelFromEnvironment();
if (typeof model === "string") {
  console.error(`${model}\nNothing was run and nothing was written.`);
  process.exit(1);
}
const connections = liveConnectionsFrom(process.env);
if (!connections.ok) {
  console.error(`${connections.error}\nNothing was run and nothing was written.`);
  process.exit(1);
}

console.log(
  `Building a stock tool for ${vendor}${values.from ? `, from ${vendor}__${values.from}` : ""}, with the ${model.name} model.`,
);
const result = await buildStockTool({
  vendor,
  goal,
  from: values.from ?? null,
  hints: values.hints ?? null,
  model,
  connections: connections.connections,
  maxAttempts,
  onProgress: (line) => console.log(`  · ${line}`),
});

if (result.ok) {
  console.log(`\n${result.tool}: ${result.files.join(", ")} in ${result.dir}.`);
  console.log(
    "Review the module and the recording, run `pnpm run check` and `pnpm --filter @graft/stock test`, and open a pull request.",
  );
  process.exit(0);
}
console.error(`\nFailed (${result.failure}): ${result.message}`);
for (const problem of result.problems ?? []) console.error(`  - ${problem}`);
if (result.lastDiagnostics !== undefined && result.lastDiagnostics !== null) {
  console.error(`Last diagnostics:\n${JSON.stringify(result.lastDiagnostics, null, 2)}`);
}
console.error("Nothing was written.");
process.exit(1);
