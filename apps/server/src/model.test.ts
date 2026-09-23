import { MODEL_KEY_FIELD, MODEL_KEY_SCOPE } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { PersonModelKeyRow } from "@graft/db/repo/person-model-key";
import { modelKeyProvider } from "@graft/db/schema/person-model-key";
import {
  MODEL_PROVIDERS,
  type ModelAdapter,
  type ModelRoute,
  NO_TELEMETRY,
  type ProviderModelConfig,
  type ProviderModelDeps,
} from "@graft/model";
import type { ModelTelemetryBacking } from "@graft/observability";
import { describe, expect, it, vi } from "vitest";

import { createModel, type ModelEnv } from "./model";

/**
 * The model's boot-time choice and the per-person routing behind it (ADR 0014), through the
 * service seam and with no provider client built: a recording factory stands where
 * `createProviderModel` would, the vault's decrypt is a fake that checks the scope, and the rows
 * are a map. What is asserted is that person A's key builds A's adapter for A's job and never B's,
 * that a person without a key falls to the deployment's fixed model, and when there is a model at
 * all.
 */

const NOW = new Date("2026-09-09T10:00:00Z");
const db = {} as DbOrTx;

const base: ModelEnv = {
  NODE_ENV: "test",
  GRAFT_BACKINGS: "open",
  GRAFT_MODEL_BACKEND: undefined,
  GRAFT_MODEL_SCRIPT: undefined,
  GRAFT_MODEL_PROVIDER: undefined,
  GRAFT_MODEL_API_KEY: undefined,
  GRAFT_MODEL_AUTHORING: undefined,
  GRAFT_MODEL_TRIAGE: undefined,
  GRAFT_MODEL_BASE_URL: undefined,
};

const FIXED: ModelEnv = {
  ...base,
  GRAFT_MODEL_BACKEND: "provider",
  GRAFT_MODEL_PROVIDER: "openai",
  GRAFT_MODEL_API_KEY: "sk-deployment",
  GRAFT_MODEL_AUTHORING: "gpt-fixed",
};

function keyRow(personId: string, provider: PersonModelKeyRow["provider"]): PersonModelKeyRow {
  return {
    personId,
    provider,
    authoringModel: `${provider}-authoring-for-${personId}`,
    triageModel: null,
    baseUrl: null,
    keyCiphertext: Buffer.from(`ciphertext-of-${personId}`),
    keySetAt: NOW,
    owner: "person",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A factory that records every configuration it was asked for and answers a recording adapter. */
function recordingFactory() {
  const built: { config: ProviderModelConfig; deps: ProviderModelDeps }[] = [];
  const opened: { adapter: string; jobId: string; personId: string }[] = [];
  const proposed: { adapter: string; personId: string; vendor: string }[] = [];
  const factory = (config: ProviderModelConfig, deps: ProviderModelDeps): ModelAdapter => {
    built.push({ config, deps });
    const name = `${config.provider}:${config.apiKey}`;
    return {
      name,
      async proposeGoals(request) {
        proposed.push({ adapter: name, personId: request.personId, vendor: request.vendor });
        return {
          goals: [`${name} goal`],
          outcome: "proposed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      open(context) {
        opened.push({ adapter: name, jobId: context.jobId, personId: context.personId });
        return {
          turn: async () => ({
            answer: { kind: "give_up", reason: name },
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        };
      },
    };
  };
  return { factory, built, opened, proposed };
}

function harness(env: ModelEnv, rows: PersonModelKeyRow[]) {
  const byPerson = new Map(rows.map((row) => [row.personId, row]));
  const decrypt = vi.fn(
    async (ciphertext: Uint8Array, scope: { personId: string; connectionId: string }) => {
      const row = byPerson.get(scope.personId);
      if (!row || !Buffer.from(ciphertext).equals(row.keyCiphertext)) {
        throw new Error("ciphertext was not minted for this person");
      }
      expect(scope.connectionId).toBe(MODEL_KEY_SCOPE);
      return { [MODEL_KEY_FIELD]: `key-of-${scope.personId}` };
    },
  );
  const { factory, built, opened, proposed } = recordingFactory();
  const routes: ModelRoute[] = [];
  const setup = createModel({
    env,
    db,
    decrypt,
    modelKey: { findPersonModelKey: async (_db, personId) => byPerson.get(personId) ?? null },
    providerFactory: factory,
    onRoute: (route) => routes.push(route),
  });
  return { setup, decrypt, built, opened, proposed, routes };
}

/** Setup's goal proposal for a person (GRA-209), as `setup-build.ts` asks it. */
const proposal = (personId: string) => ({
  personId,
  traceId: `setup:${personId}`,
  vendor: "demo",
  displayName: "Demo",
  primaryHost: "https://api.demo.example",
  docsUrl: null,
  curatedGoal: null,
});

const job = (jobId: string, personId: string) => ({
  jobId,
  personId,
  goal: "g",
  hints: null,
  connection: {
    id: "c",
    vendor: "demo",
    displayName: "Demo",
    scheme: "bearer",
    primaryHost: "https://api.demo.example",
    hosts: ["api.demo.example"],
  },
  skill: "s",
  budget: { maxAttempts: 3, tokenCeiling: 1000 },
});

describe("the provider enum", () => {
  it("is the same list in the schema and in the model package", () => {
    expect([...modelKeyProvider]).toEqual([...MODEL_PROVIDERS]);
  });
});

describe("createModel", () => {
  it("routes person A's job to A's own key and person B's to the fixed model, decrypting only A's ciphertext under A's scope", async () => {
    const { setup, decrypt, built, opened, routes } = harness(FIXED, [
      keyRow("person_a", "anthropic"),
    ]);
    const { model, fixed, summary } = await setup;
    expect(fixed?.name).toBe("openai:sk-deployment");
    expect(built.map((b) => b.config)).toEqual([
      {
        provider: "openai",
        apiKey: "sk-deployment",
        authoringModel: "gpt-fixed",
        triageModel: null,
        baseUrl: null,
      },
    ]);
    if (!model) throw new Error("a fixed model means a model");

    const a = await model.open(job("job_a", "person_a")).turn({ kind: "goal" });
    const b = await model.open(job("job_b", "person_b")).turn({ kind: "goal" });

    expect(a.answer).toEqual({ kind: "give_up", reason: "anthropic:key-of-person_a" });
    expect(b.answer).toEqual({ kind: "give_up", reason: "openai:sk-deployment" });
    // A's key built exactly one adapter, from A's row, with A's model ids.
    expect(built[1]?.config).toEqual({
      provider: "anthropic",
      apiKey: "key-of-person_a",
      authoringModel: "anthropic-authoring-for-person_a",
      triageModel: null,
      baseUrl: null,
    });
    expect(built).toHaveLength(2);
    // Decrypt ran once, for A, under A's model-key scope; B's job asked the vault for nothing.
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls[0]?.[1]).toEqual({
      personId: "person_a",
      connectionId: MODEL_KEY_SCOPE,
    });
    // Each adapter saw its own person's job and no other.
    expect(opened).toEqual([
      { adapter: "anthropic:key-of-person_a", jobId: "job_a", personId: "person_a" },
      { adapter: "openai:sk-deployment", jobId: "job_b", personId: "person_b" },
    ]);
    expect(routes.map((r) => [r.personId, r.source])).toEqual([
      ["person_a", "person"],
      ["person_b", "fixed"],
    ]);
    expect(summary).toBe("model openai:sk-deployment, a person's own key routes their jobs");
  });

  it("never lets a person's key answer another person's job — B's job with B's own key uses B's, not A's", async () => {
    const { setup, built, opened } = harness(FIXED, [
      keyRow("person_a", "anthropic"),
      keyRow("person_b", "openai"),
    ]);
    const { model } = await setup;
    if (!model) throw new Error("a fixed model means a model");
    await model.open(job("job_b", "person_b")).turn({ kind: "goal" });
    await model.open(job("job_a", "person_a")).turn({ kind: "goal" });
    expect(built.slice(1).map((b) => b.config.apiKey)).toEqual([
      "key-of-person_b",
      "key-of-person_a",
    ]);
    expect(opened).toEqual([
      { adapter: "openai:key-of-person_b", jobId: "job_b", personId: "person_b" },
      { adapter: "anthropic:key-of-person_a", jobId: "job_a", personId: "person_a" },
    ]);
  });

  it("routes Setup's goal proposal as it routes jobs: A's own key for A, the fixed model for B", async () => {
    const { setup, decrypt, built, proposed } = harness(FIXED, [keyRow("person_a", "anthropic")]);
    const { model } = await setup;
    if (!model?.proposeGoals) throw new Error("a fixed model means a proposer");

    const a = await model.proposeGoals(proposal("person_a"));
    const b = await model.proposeGoals(proposal("person_b"));

    expect(a.goals).toEqual(["anthropic:key-of-person_a goal"]);
    expect(b.goals).toEqual(["openai:sk-deployment goal"]);
    // A's vendor's name went to A's provider alone; B's to the deployment's.
    expect(proposed).toEqual([
      { adapter: "anthropic:key-of-person_a", personId: "person_a", vendor: "demo" },
      { adapter: "openai:sk-deployment", personId: "person_b", vendor: "demo" },
    ]);
    expect(built[1]?.config.apiKey).toBe("key-of-person_a");
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls[0]?.[1]).toEqual({
      personId: "person_a",
      connectionId: MODEL_KEY_SCOPE,
    });
  });

  it("proposes nothing under the hosted form for a person with no key and no fixed model", async () => {
    const { setup, proposed } = harness({ ...base, GRAFT_BACKINGS: "cloud" }, []);
    const { model } = await setup;
    if (!model?.proposeGoals) throw new Error("the hosted form routes");
    expect(await model.proposeGoals(proposal("person_z"))).toMatchObject({
      goals: [],
      outcome: "unavailable",
    });
    expect(proposed).toEqual([]);
  });

  it("configures no model under the open form when none is set, so acquire refuses at the door", async () => {
    const { setup, built } = harness(base, [keyRow("person_a", "anthropic")]);
    const { model, fixed, summary } = await setup;
    expect(model).toBeNull();
    expect(fixed).toBeNull();
    expect(built).toEqual([]);
    expect(summary).toBe("model none");
  });

  it("routes under the hosted form even with no fixed model: a person's key is their way to author", async () => {
    const { setup } = harness({ ...base, GRAFT_BACKINGS: "cloud" }, [keyRow("person_a", "openai")]);
    const { model, fixed } = await setup;
    expect(fixed).toBeNull();
    if (!model) throw new Error("the hosted form routes");
    const a = await model.open(job("job_a", "person_a")).turn({ kind: "goal" });
    expect(a.answer).toEqual({ kind: "give_up", reason: "openai:key-of-person_a" });
    await expect(model.open(job("job_z", "person_z")).turn({ kind: "goal" })).rejects.toThrow(
      /person_z has no key of their own/,
    );
  });

  it("plays a scripted model from its file, and hands the fixed provider the base URL", async () => {
    const script = JSON.stringify({
      steps: [{ on: "goal", answer: { kind: "give_up", reason: "scripted" } }],
    });
    const scripted = await createModel({
      env: { ...base, GRAFT_MODEL_BACKEND: "scripted", GRAFT_MODEL_SCRIPT: "./script.json" },
      db,
      decrypt: async () => ({}),
      modelKey: { findPersonModelKey: async () => null },
      readScript: async (path) => {
        expect(path).toBe("./script.json");
        return script;
      },
    });
    expect(scripted.fixed?.name).toBe("scripted");
    expect(scripted.summary).toBe(
      "model scripted (./script.json), a person's own key routes their jobs",
    );
    if (!scripted.model) throw new Error("scripted is a model");
    const reply = await scripted.model.open(job("j", "p")).turn({ kind: "goal" });
    expect(reply.answer).toEqual({ kind: "give_up", reason: "scripted" });

    const { setup, built } = harness(
      { ...FIXED, GRAFT_MODEL_BASE_URL: "https://gateway.example/v1" },
      [],
    );
    const { summary } = await setup;
    expect(built[0]?.config.baseUrl).toBe("https://gateway.example/v1");
    expect(summary).toContain("via https://gateway.example/v1");
  });

  it("hands the telemetry backing the selector answered to the fixed model and to every person's", async () => {
    const telemetry = { ...NO_TELEMETRY };
    const backing: ModelTelemetryBacking = {
      name: "traced",
      telemetry,
      flush: async () => {},
      shutdown: async () => {},
    };
    const { factory, built } = recordingFactory();
    const rows = new Map([["person_a", keyRow("person_a", "anthropic")]]);
    const { model } = await createModel({
      env: FIXED,
      db,
      decrypt: async () => ({ [MODEL_KEY_FIELD]: "key-of-person_a" }),
      modelKey: { findPersonModelKey: async (_db, personId) => rows.get(personId) ?? null },
      providerFactory: factory,
      telemetry: backing,
    });
    expect(built[0]?.deps.telemetry).toBe(telemetry);
    if (!model) throw new Error("a fixed model means a model");
    await model.open(job("job_a", "person_a")).turn({ kind: "goal" });
    expect(built[1]?.deps.telemetry).toBe(telemetry);
  });

  it("runs every adapter under NO_TELEMETRY when the selector answered no backing — the open form", async () => {
    const { setup, built } = harness(FIXED, []);
    await setup;
    expect(built[0]?.deps.telemetry).toBe(NO_TELEMETRY);
  });
});
