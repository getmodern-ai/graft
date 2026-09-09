import type { PersonModelKeyRow } from "@graft/db/repo/person-model-key";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { ModelKeyDeps } from "./model-key.deps";
import {
  deletePersonModelKey,
  findPersonModelKeyRow,
  getPersonModelKey,
  MODEL_KEY_FIELD,
  MODEL_KEY_MAX_LENGTH,
  MODEL_KEY_SCOPE,
  modelKeyScope,
  setPersonModelKey,
} from "./model-key.service";

/**
 * The model-key service with fakes and no database: the key reaches the vault under the person's
 * model-key scope and nothing else, every answer is the public shape, and the rules on what may be
 * entered are the service's own.
 */

const NOW = new Date("2026-09-09T10:00:00Z");
const CIPHERTEXT = Buffer.from("ciphertext-bytes");
const A = { personId: "person_a" };
const B = { personId: "person_b" };

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

function fakeDeps() {
  const rows = new Map<string, PersonModelKeyRow>();
  const encrypt = vi.fn(async () => CIPHERTEXT);
  const deps: ModelKeyDeps = {
    findPersonModelKey: async (_db, personId) => rows.get(personId) ?? null,
    upsertPersonModelKey: async (_db, input) => {
      const row: PersonModelKeyRow = {
        personId: input.personId,
        provider: input.provider,
        authoringModel: input.authoringModel ?? null,
        triageModel: input.triageModel ?? null,
        baseUrl: input.baseUrl ?? null,
        keyCiphertext: input.keyCiphertext,
        keySetAt: input.keySetAt,
        owner: "person",
        createdAt: rows.get(input.personId)?.createdAt ?? NOW,
        updatedAt: NOW,
      };
      rows.set(input.personId, row);
      return row;
    },
    deletePersonModelKey: async (_db, personId) => {
      const row = rows.get(personId) ?? null;
      rows.delete(personId);
      return row;
    },
    vault: { encrypt },
    now: () => NOW,
  };
  return { deps, rows, encrypt };
}

describe("setPersonModelKey", () => {
  it("encrypts the key under the person's model-key scope, writes the ciphertext, and answers without the key", async () => {
    const { deps, rows, encrypt } = fakeDeps();
    const output = await setPersonModelKey(
      ctx,
      A,
      { provider: "anthropic", apiKey: " sk-ant-secret-key ", authoringModel: " claude-x " },
      deps,
    );
    expect(encrypt).toHaveBeenCalledWith(
      { [MODEL_KEY_FIELD]: "sk-ant-secret-key" },
      { personId: "person_a", connectionId: MODEL_KEY_SCOPE },
    );
    expect(rows.get("person_a")?.keyCiphertext).toBe(CIPHERTEXT);
    expect(output).toEqual({
      provider: "anthropic",
      authoringModel: "claude-x",
      triageModel: null,
      baseUrl: null,
      setAt: NOW,
    });
    expect(JSON.stringify(output)).not.toContain("sk-ant");
    expect(output).not.toHaveProperty("keyCiphertext");
  });

  it("replaces an earlier key in place — one row per person", async () => {
    const { deps, rows } = fakeDeps();
    await setPersonModelKey(ctx, A, { provider: "anthropic", apiKey: "first" }, deps);
    await setPersonModelKey(
      ctx,
      A,
      { provider: "openai", apiKey: "second", baseUrl: "https://gateway.example/v1" },
      deps,
    );
    expect(rows.size).toBe(1);
    expect(rows.get("person_a")).toMatchObject({
      provider: "openai",
      baseUrl: "https://gateway.example/v1",
    });
  });

  it("refuses an unknown provider, a key that is empty, spaced or too long, a spaced model id, and a base URL that is not http(s)", async () => {
    const { deps, encrypt } = fakeDeps();
    const refused = async (input: Parameters<typeof setPersonModelKey>[2], field: string) => {
      const error = await setPersonModelKey(ctx, A, input, deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).code).toBe("BAD_REQUEST");
      expect((error as ServiceError).details).toEqual({ field });
    };
    await refused({ provider: "gemini", apiKey: "k" }, "provider");
    await refused({ provider: "openai", apiKey: "" }, "apiKey");
    await refused({ provider: "openai", apiKey: "has space" }, "apiKey");
    await refused({ provider: "openai", apiKey: "k".repeat(MODEL_KEY_MAX_LENGTH + 1) }, "apiKey");
    await refused({ provider: "openai", apiKey: "k", triageModel: "two words" }, "triageModel");
    await refused({ provider: "openai", apiKey: "k", baseUrl: "gateway.example" }, "baseUrl");
    await refused({ provider: "openai", apiKey: "k", baseUrl: "ftp://gateway.example" }, "baseUrl");
    // Nothing reached the vault.
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("reads a blank model id or base URL as the provider's default", async () => {
    const { deps } = fakeDeps();
    const output = await setPersonModelKey(
      ctx,
      A,
      { provider: "openai", apiKey: "k", authoringModel: "  ", triageModel: null, baseUrl: "" },
      deps,
    );
    expect(output).toMatchObject({ authoringModel: null, triageModel: null, baseUrl: null });
  });
});

describe("getPersonModelKey, deletePersonModelKey and the resolver's read", () => {
  it("answers null for a person without a key, the public shape for one with, and each person's own", async () => {
    const { deps } = fakeDeps();
    expect(await getPersonModelKey(ctx, A, deps)).toBeNull();
    await setPersonModelKey(ctx, A, { provider: "openai", apiKey: "a-key" }, deps);
    expect(await getPersonModelKey(ctx, A, deps)).toMatchObject({ provider: "openai", setAt: NOW });
    expect(await getPersonModelKey(ctx, B, deps)).toBeNull();
    const row = await findPersonModelKeyRow(ctx, "person_a", deps);
    expect(row?.keyCiphertext).toBe(CIPHERTEXT);
    expect(await findPersonModelKeyRow(ctx, "person_b", deps)).toBeNull();
  });

  it("deletes the key and says whether there was one", async () => {
    const { deps } = fakeDeps();
    expect(await deletePersonModelKey(ctx, A, deps)).toBe(false);
    await setPersonModelKey(ctx, A, { provider: "openai", apiKey: "a-key" }, deps);
    expect(await deletePersonModelKey(ctx, A, deps)).toBe(true);
    expect(await getPersonModelKey(ctx, A, deps)).toBeNull();
  });

  it("binds the ciphertext to the person under a slot no connection id can be", () => {
    expect(modelKeyScope("person_a")).toEqual({
      personId: "person_a",
      connectionId: "person-model-key",
    });
    expect(MODEL_KEY_SCOPE).not.toMatch(/^[0-9a-f-]{36}$/);
  });
});
