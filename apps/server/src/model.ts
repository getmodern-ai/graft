import { readFile } from "node:fs/promises";

import {
  findPersonModelKeyRow,
  MODEL_KEY_FIELD,
  type ModelKeyDeps,
  modelKeyScope,
  type ServiceContext,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { ServerEnv } from "@graft/env/server";
import {
  createProviderModel,
  createRoutedModel,
  createScriptedModel,
  type ModelAdapter,
  type ModelRoute,
  type ModelTelemetry,
  NO_TELEMETRY,
  type ProviderModelConfig,
  type ProviderModelDeps,
  parseScript,
} from "@graft/model";
import type { ModelTelemetryBacking } from "@graft/observability";
import type { CredentialVault } from "@graft/vault";

/**
 * Which model answers `acquire` for this process, chosen once at boot from the environment
 * (ADR 0004; ADR 0014): the deployment's **fixed** model — the provider-backed adapter under
 * `GRAFT_MODEL_BACKEND=provider`, the scripted one under `scripted`, none otherwise — with the
 * per-person router in front of it, so a person who has brought their own key (`person_model_key`)
 * has their jobs answered by their provider and nobody else's. The model telemetry backing the
 * selector answered (`backings.ts`; ADR 0002 as amended 2026-09-19 — none in the open form, the
 * private package's under `cloud`) is handed to every adapter as the one telemetry binding, per
 * call and never registered globally (`@graft/model`'s `telemetry.ts` says why).
 *
 * **This is the second place in the server a stored secret becomes plaintext**, after the proxy's
 * binding in `app.ts`: a person's own key is decrypted here, under the person's model-key scope, to
 * build their provider client — and nowhere else. The request paths hold the vault's encrypt half
 * alone (`@graft/core`'s `ModelKeyDeps`), so a route cannot read a key back. The decrypt is handed
 * in as a function, not the vault, for the same reason the proxy's is.
 *
 * When routing applies: whenever a fixed model exists, and always under the hosted form (`cloud`),
 * where a person's key is the pricing option ADR 0014 names. Under the open form with no fixed model
 * — a laptop that configured none — `acquire` refuses `acquire_unconfigured` at the door rather than
 * accepting a job that fails for want of a key.
 */

export type ModelEnv = Pick<
  ServerEnv,
  | "NODE_ENV"
  | "GRAFT_BACKINGS"
  | "GRAFT_MODEL_BACKEND"
  | "GRAFT_MODEL_SCRIPT"
  | "GRAFT_MODEL_PROVIDER"
  | "GRAFT_MODEL_API_KEY"
  | "GRAFT_MODEL_AUTHORING"
  | "GRAFT_MODEL_TRIAGE"
  | "GRAFT_MODEL_BASE_URL"
>;

export type ModelSetup = {
  /** What `McpDeps.model` is handed; null means `acquire` refuses `acquire_unconfigured`. */
  model: ModelAdapter | null;
  /** The deployment's own model, before routing; null when none is configured. */
  fixed: ModelAdapter | null;
  /** One clause for the boot line. */
  summary: string;
};

export type CreateModelInput = {
  env: ModelEnv;
  db: DbOrTx;
  /** The vault's decrypt half, for a person's own key — see the header. */
  decrypt: CredentialVault["decrypt"];
  modelKey: Pick<ModelKeyDeps, "findPersonModelKey">;
  onRoute?: (route: ModelRoute) => void;
  /** The telemetry backing every adapter is built with — `Backings.modelTelemetry`; null runs them under `NO_TELEMETRY`. */
  telemetry?: ModelTelemetryBacking | null;
  /** Test seams: a stand-in for the provider adapter, and the script reader. */
  providerFactory?: (config: ProviderModelConfig, deps: ProviderModelDeps) => ModelAdapter;
  readScript?: (path: string) => Promise<string>;
};

/** The one place a person's key row is read back into a provider configuration. */
async function ownModelFor(
  personId: string,
  input: CreateModelInput,
  telemetry: ModelTelemetry,
  providerFactory: NonNullable<CreateModelInput["providerFactory"]>,
): Promise<ModelAdapter | null> {
  const ctx: ServiceContext = { db: input.db };
  const row = await findPersonModelKeyRow(ctx, personId, input.modelKey);
  if (!row) return null;
  const fields = await input.decrypt(row.keyCiphertext, modelKeyScope(personId));
  const apiKey = fields[MODEL_KEY_FIELD];
  if (!apiKey) {
    throw new Error(
      `person ${personId}'s model key decrypted to a record without ${MODEL_KEY_FIELD}`,
    );
  }
  return providerFactory(
    {
      provider: row.provider,
      apiKey,
      authoringModel: row.authoringModel,
      triageModel: row.triageModel,
      baseUrl: row.baseUrl,
    },
    { telemetry },
  );
}

export async function createModel(input: CreateModelInput): Promise<ModelSetup> {
  const { env } = input;
  const providerFactory = input.providerFactory ?? createProviderModel;

  const telemetry = input.telemetry?.telemetry ?? NO_TELEMETRY;

  let fixed: ModelAdapter | null = null;
  let fixedSummary = "none";
  if (env.GRAFT_MODEL_BACKEND === "scripted") {
    if (!env.GRAFT_MODEL_SCRIPT) {
      // `@graft/env` refuses the half pair at boot; this keeps the narrowing honest for a caller
      // that assembled the environment another way.
      throw new Error("GRAFT_MODEL_BACKEND=scripted needs GRAFT_MODEL_SCRIPT");
    }
    const raw = await (input.readScript ?? ((path) => readFile(path, "utf8")))(
      env.GRAFT_MODEL_SCRIPT,
    );
    fixed = createScriptedModel(parseScript(JSON.parse(raw)));
    fixedSummary = `scripted (${env.GRAFT_MODEL_SCRIPT})`;
  } else if (env.GRAFT_MODEL_BACKEND === "provider") {
    if (!env.GRAFT_MODEL_PROVIDER || !env.GRAFT_MODEL_API_KEY) {
      throw new Error(
        "GRAFT_MODEL_BACKEND=provider needs GRAFT_MODEL_PROVIDER and GRAFT_MODEL_API_KEY",
      );
    }
    fixed = providerFactory(
      {
        provider: env.GRAFT_MODEL_PROVIDER,
        apiKey: env.GRAFT_MODEL_API_KEY,
        authoringModel: env.GRAFT_MODEL_AUTHORING ?? null,
        triageModel: env.GRAFT_MODEL_TRIAGE ?? null,
        baseUrl: env.GRAFT_MODEL_BASE_URL ?? null,
      },
      { telemetry },
    );
    fixedSummary =
      fixed.name + (env.GRAFT_MODEL_BASE_URL ? ` via ${env.GRAFT_MODEL_BASE_URL}` : "");
  }

  const routing = fixed !== null || env.GRAFT_BACKINGS === "cloud";
  const model = routing
    ? createRoutedModel({
        fixed,
        resolve: (personId) => ownModelFor(personId, input, telemetry, providerFactory),
        onRoute: input.onRoute,
      })
    : null;

  const summary = `model ${fixedSummary}${routing ? ", a person's own key routes their jobs" : ""}`;
  return { model, fixed, summary };
}
