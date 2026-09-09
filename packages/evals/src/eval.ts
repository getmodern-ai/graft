import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  createProviderModel,
  MODEL_PROVIDERS,
  type ModelAdapter,
  type ModelProviderName,
} from "@graft/model";
import dotenv from "dotenv";

import { runScenario } from "./run-scenario";
import { scenarios } from "./scenarios";
import { renderScorecard, type ScenarioReport } from "./scorecard";
import { scriptedModelFor } from "./scripted-answers";
import { openWorld } from "./world";

/**
 * The evals, run by name and never from `pnpm test`, because every scenario asks a real model to
 * author a tool and that costs money:
 *
 *   pnpm --filter @graft/evals eval                       # every scenario, the provider from the environment
 *   pnpm --filter @graft/evals eval -- --scenario write   # the scenarios whose name contains "write"
 *   pnpm --filter @graft/evals eval -- --scripted         # the harness's own test: canned answers, no key
 *   pnpm --filter @graft/evals eval -- --attempts 3       # the attempt cap (default 3)
 *
 * The provider comes from `GRAFT_MODEL_PROVIDER`, `GRAFT_MODEL_API_KEY` and the optional
 * `GRAFT_MODEL_AUTHORING`, `GRAFT_MODEL_TRIAGE`, `GRAFT_MODEL_BASE_URL` — in the environment or in
 * `apps/server/.env`, the one development file. Without the pair the run says what is missing and
 * exits non-zero before opening anything. The exit code is non-zero when any scenario is not green
 * on every scorer, which is what lets this gate a change to the skill or the prompts (ADR 0012, L3).
 */

dotenv.config({
  path: fileURLToPath(new URL("../../../apps/server/.env", import.meta.url)),
  quiet: true,
});

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    scripted: { type: "boolean", default: false },
    scenario: { type: "string", multiple: true },
    attempts: { type: "string", default: "3" },
    quiet: { type: "boolean", default: false },
  },
});

const maxAttempts = Number(values.attempts);
if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
  console.error(`--attempts must be a whole number of at least 1, not ${values.attempts}`);
  process.exit(2);
}
const tokenCeiling = 400_000;

const wanted = values.scenario?.length
  ? scenarios.filter((s) => values.scenario?.some((needle) => s.name.includes(needle)))
  : scenarios;
if (wanted.length === 0) {
  console.error(
    `No scenario matches ${JSON.stringify(values.scenario)}. Known: ${scenarios.map((s) => s.name).join(" | ")}`,
  );
  process.exit(2);
}

function isProvider(value: string | undefined): value is ModelProviderName {
  return MODEL_PROVIDERS.includes(value as ModelProviderName);
}

/** The model for a scenario: canned answers under `--scripted`, otherwise the one provider adapter. */
let modelFor: (scenario: (typeof scenarios)[number]) => ModelAdapter;
let modelName: string;
if (values.scripted) {
  modelFor = scriptedModelFor;
  modelName = "scripted (the harness's own test; no provider called)";
} else {
  const provider = process.env.GRAFT_MODEL_PROVIDER;
  const apiKey = process.env.GRAFT_MODEL_API_KEY;
  const missing = [
    ...(isProvider(provider) ? [] : ["GRAFT_MODEL_PROVIDER (anthropic or openai)"]),
    ...(apiKey ? [] : ["GRAFT_MODEL_API_KEY"]),
  ];
  if (missing.length > 0 || !isProvider(provider) || !apiKey) {
    console.error(
      [
        "The evals need a real model and none is configured.",
        `Missing: ${missing.join(", ")}.`,
        "Set them in the environment or in apps/server/.env, or run the harness's own test with --scripted.",
        "Nothing was opened and no provider was called.",
      ].join("\n"),
    );
    process.exit(1);
  }
  const adapter = createProviderModel({
    provider,
    apiKey,
    authoringModel: process.env.GRAFT_MODEL_AUTHORING ?? null,
    triageModel: process.env.GRAFT_MODEL_TRIAGE ?? null,
    baseUrl: process.env.GRAFT_MODEL_BASE_URL ?? null,
  });
  modelFor = () => adapter;
  modelName = `${adapter.name}, triage ${adapter.settings.triageModel}${adapter.settings.baseUrl ? ` via ${adapter.settings.baseUrl}` : ""}`;
}

const log = values.quiet ? () => {} : (line: string) => console.log(line);
const reports: ScenarioReport[] = [];

for (const scenario of wanted) {
  log(`\n▶ ${scenario.name}`);
  const world = await openWorld({ model: modelFor(scenario), maxAttempts, tokenCeiling });
  try {
    const run = await runScenario(world, scenario, {
      onProgress: (line) => log(`  · ${line}`),
    });
    const scores = scenario.score(run, { maxAttempts, tokenCeiling });
    reports.push({ scenario, run, scores });
    log(
      `  ${scores.every((s) => s.pass) ? "green" : `${scores.filter((s) => !s.pass).length} red`}`,
    );
  } catch (error) {
    reports.push({
      scenario,
      run: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      scores: [],
    });
    log(`  threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await world.close();
  }
}

console.log(renderScorecard(reports, { model: modelName }));
const green = reports.every((r) => r.error === undefined && r.scores.every((s) => s.pass));
process.exit(green ? 0 : 1);
