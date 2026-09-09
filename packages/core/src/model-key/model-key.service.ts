import type { PersonModelKeyRow } from "@graft/db/repo/person-model-key";
import { type ModelKeyProvider, modelKeyProvider } from "@graft/db/schema/person-model-key";
import type { CredentialScope } from "@graft/vault";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { Principal } from "../tenancy";
import type { ModelKeyDeps } from "./model-key.deps";

/**
 * A person's own model key (ADR 0014): entered in the console, encrypted here through the vault's
 * encrypt half, and from then on read only by the model resolver that runs that person's `acquire`
 * jobs. Write-only after entry: every answer this module gives carries the provider, the model ids,
 * the base URL and when the key was set, and never the key. "Set at" rather than a masked key,
 * because a masked key invites a comparison that a date does not.
 */

/**
 * The slot the vault's encryption context binds a model key to, where a connection's credential
 * carries its connection id (`CredentialScope`). A word no connection id can be — ids are UUIDs —
 * so a model key's ciphertext cannot be read back under a connection's scope or the reverse, and
 * the person's id is bound the same way it is for a credential.
 */
export const MODEL_KEY_SCOPE = "person-model-key";

export function modelKeyScope(personId: string): CredentialScope {
  return { personId, connectionId: MODEL_KEY_SCOPE };
}

/** The field name the key is encrypted under; what the resolver reads back. */
export const MODEL_KEY_FIELD = "apiKey";

export const MODEL_KEY_MAX_LENGTH = 512;
export const MODEL_ID_MAX_LENGTH = 200;

export type ModelKeyOutput = {
  provider: ModelKeyProvider;
  authoringModel: string | null;
  triageModel: string | null;
  baseUrl: string | null;
  /** When the key was last entered — the one thing said about the key itself. */
  setAt: Date;
};

export type SetModelKeyInput = {
  provider: string;
  apiKey: string;
  authoringModel?: string | null;
  triageModel?: string | null;
  baseUrl?: string | null;
};

/** The row's public shape: no ciphertext, no key. */
export function toModelKeyOutput(row: PersonModelKeyRow): ModelKeyOutput {
  return {
    provider: row.provider,
    authoringModel: row.authoringModel,
    triageModel: row.triageModel,
    baseUrl: row.baseUrl,
    setAt: row.keySetAt,
  };
}

function isProvider(value: string): value is ModelKeyProvider {
  return (modelKeyProvider as readonly string[]).includes(value);
}

function optionalId(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MODEL_ID_MAX_LENGTH || /\s/.test(trimmed)) {
    throw new ServiceError("BAD_REQUEST", `${field} must be a model id without spaces`, {
      details: { field },
    });
  }
  return trimmed;
}

function optionalBaseUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ServiceError("BAD_REQUEST", "baseUrl must be an absolute http(s) URL", {
      details: { field: "baseUrl" },
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ServiceError("BAD_REQUEST", "baseUrl must be an absolute http(s) URL", {
      details: { field: "baseUrl" },
    });
  }
  return trimmed;
}

/** The person's key as the console shows it, or null when they have none. */
export async function getPersonModelKey(
  ctx: ServiceContext,
  principal: Principal,
  deps: ModelKeyDeps,
): Promise<ModelKeyOutput | null> {
  const row = await deps.findPersonModelKey(ctx.db, principal.personId);
  return row ? toModelKeyOutput(row) : null;
}

/**
 * Enter or replace the person's key. The key is checked for shape, encrypted under the person's
 * model-key scope, and written in one statement; the answer is the public shape.
 */
export async function setPersonModelKey(
  ctx: ServiceContext,
  principal: Principal,
  input: SetModelKeyInput,
  deps: ModelKeyDeps,
): Promise<ModelKeyOutput> {
  if (!isProvider(input.provider)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `provider must be one of ${modelKeyProvider.join(", ")}`,
      { details: { field: "provider" } },
    );
  }
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (apiKey.length === 0 || apiKey.length > MODEL_KEY_MAX_LENGTH || /\s/.test(apiKey)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `apiKey must be a non-empty key of at most ${MODEL_KEY_MAX_LENGTH} characters, without spaces`,
      { details: { field: "apiKey" } },
    );
  }
  const authoringModel = optionalId(input.authoringModel, "authoringModel");
  const triageModel = optionalId(input.triageModel, "triageModel");
  const baseUrl = optionalBaseUrl(input.baseUrl);

  const keyCiphertext = await deps.vault.encrypt(
    { [MODEL_KEY_FIELD]: apiKey },
    modelKeyScope(principal.personId),
  );
  const row = await deps.upsertPersonModelKey(ctx.db, {
    personId: principal.personId,
    provider: input.provider,
    authoringModel,
    triageModel,
    baseUrl,
    keyCiphertext,
    keySetAt: deps.now(),
  });
  return toModelKeyOutput(row);
}

/** Remove the person's key; true when one was there. */
export async function deletePersonModelKey(
  ctx: ServiceContext,
  principal: Principal,
  deps: ModelKeyDeps,
): Promise<boolean> {
  const row = await deps.deletePersonModelKey(ctx.db, principal.personId);
  return row !== null;
}

/**
 * The resolver's read: the row with its ciphertext, for the one component that decrypts it
 * (`apps/server/src/model.ts`). Takes a person id rather than a principal because it runs inside a
 * job, where there is no session — the id is the job's person (ADR 0007), and the decrypt is
 * bound to it by the vault's scope whatever the caller passes.
 */
export async function findPersonModelKeyRow(
  ctx: ServiceContext,
  personId: string,
  deps: Pick<ModelKeyDeps, "findPersonModelKey">,
): Promise<PersonModelKeyRow | null> {
  return deps.findPersonModelKey(ctx.db, personId);
}
