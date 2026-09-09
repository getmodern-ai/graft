import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { describe, it, vi } from "vitest";

import { modelConformance } from "./conformance";
import { createProviderModel, MODEL_PROVIDERS, type ModelProviderName } from "./provider";

/**
 * The conformance suite against a real provider — the check that the provider-backed adapter
 * answers the same questions the scripted one does, with a model rather than a mock (ADR 0002).
 * Costs money and needs a key, so it runs only by name:
 *
 *   pnpm --filter @graft/model test:live        # GRAFT_MODEL_LIVE=1 vitest run src/provider.live.test.ts
 *
 * with `GRAFT_MODEL_PROVIDER`, `GRAFT_MODEL_API_KEY` and, optionally, `GRAFT_MODEL_AUTHORING`,
 * `GRAFT_MODEL_TRIAGE` and `GRAFT_MODEL_BASE_URL` in the environment or in `apps/server/.env`, the
 * one file that holds the development environment. Without `GRAFT_MODEL_LIVE=1` the file is one
 * skipped test, so `pnpm run test` never reaches a provider.
 */

dotenv.config({
  path: fileURLToPath(new URL("../../../apps/server/.env", import.meta.url)),
  quiet: true,
});

const live = process.env.GRAFT_MODEL_LIVE === "1";
const provider = process.env.GRAFT_MODEL_PROVIDER;
const apiKey = process.env.GRAFT_MODEL_API_KEY;

function isProvider(value: string | undefined): value is ModelProviderName {
  return MODEL_PROVIDERS.includes(value as ModelProviderName);
}

if (live && isProvider(provider) && apiKey) {
  // A real model reads a page and drafts a module; give each case minutes, not seconds.
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });
  modelConformance(`provider (live: ${provider})`, async () => ({
    adapter: createProviderModel({
      provider,
      apiKey,
      authoringModel: process.env.GRAFT_MODEL_AUTHORING ?? null,
      triageModel: process.env.GRAFT_MODEL_TRIAGE ?? null,
      baseUrl: process.env.GRAFT_MODEL_BASE_URL ?? null,
    }),
  }));
} else {
  describe("provider conformance, live", () => {
    it.skip(
      live
        ? "GRAFT_MODEL_LIVE=1 but GRAFT_MODEL_PROVIDER (anthropic | openai) and GRAFT_MODEL_API_KEY are not both set"
        : "runs only with GRAFT_MODEL_LIVE=1 — pnpm --filter @graft/model test:live",
      () => {},
    );
  });
}
