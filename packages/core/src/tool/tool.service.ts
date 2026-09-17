import type { AuthoredToolPatch, AuthoredToolRow, ToolVersionRow } from "@graft/db/repo/tool";

import { validateVendor } from "../connection/connection.rules";
import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import { isKebabCase } from "../kebab-case";
import type { Principal } from "../tenancy";
import type { ToolDeps } from "./tool.deps";

/**
 * The toolbox (CONTEXT.md; ADR 0003, ADR 0009): create a tool, add a version, activate one — the
 * pointer and the definition together — list, look up by vendor and name. Postgres holds pointers;
 * the module itself lives in the toolbox directory GRA-18's publish writes. Nothing here deletes
 * anything.
 */

export const TOOL_NAME_MAX_LENGTH = 64;
export const TOOL_DESCRIPTION_MAX_LENGTH = 2000;

export type ToolAnnotations = { readOnly: boolean; destructive: boolean };

export type CreateToolInput = {
  vendor: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** From the check, never from the model's declaration (ADR 0008). */
  annotations: ToolAnnotations;
  defaultConnectionId?: string | null;
};

export type ToolVersionInput = {
  /** The version's directory in the toolbox. */
  path: string;
  sourceHash: string;
  lockfileHash?: string | null;
  checkOutput: Record<string, unknown>;
  dryRunOutcome?: Record<string, unknown> | null;
  dryRunAt?: Date | null;
  writesInvolved?: boolean;
  publisherJobId?: string | null;
};

export type ToolDefinitionPatch = {
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  defaultConnectionId?: string | null;
};

function validateName(name: string): void {
  if (name.length === 0 || name.length > TOOL_NAME_MAX_LENGTH || !isKebabCase(name)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `A tool's name is kebab-case, 1 to ${TOOL_NAME_MAX_LENGTH} characters, like list-messages`,
    );
  }
}

function validateDescription(description: string): void {
  const trimmed = description.trim();
  if (trimmed.length === 0 || trimmed.length > TOOL_DESCRIPTION_MAX_LENGTH) {
    throw new ServiceError(
      "BAD_REQUEST",
      `A tool's description is 1 to ${TOOL_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
}

function validateInputSchema(schema: Record<string, unknown>): void {
  if (schema.type !== "object") {
    throw new ServiceError(
      "BAD_REQUEST",
      'A tool\'s input schema is a JSON Schema object with type "object"',
    );
  }
}

/**
 * The four rules a tool's definition must pass, together, before anything is written — the publish
 * (`@graft/publish`) asks this first, so a bad name is refused before a version directory exists for
 * it. `createTool` and `updateToolDefinition` apply the same rules on their own inputs.
 */
export function validateToolDefinition(input: {
  vendor: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): void {
  const vendorProblem = validateVendor(input.vendor);
  if (vendorProblem) throw new ServiceError("BAD_REQUEST", vendorProblem);
  validateName(input.name);
  validateDescription(input.description);
  validateInputSchema(input.inputSchema);
}

async function assertOwnedConnection(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string | null | undefined,
  deps: ToolDeps,
): Promise<void> {
  if (!connectionId) return;
  orNotFound(
    await deps.findConnection(ctx.db, principal.personId, connectionId),
    "Connection not found",
  );
}

/**
 * Create the tool row, with no version yet — `addToolVersion` follows, or `publishToolVersion` does
 * both. Refused as `CONFLICT` when the person already has a tool of that vendor and name: the
 * unique constraint would say the same, later and less clearly.
 */
export async function createTool(
  ctx: ServiceContext,
  principal: Principal,
  input: CreateToolInput,
  deps: ToolDeps,
): Promise<AuthoredToolRow> {
  validateToolDefinition(input);
  await assertOwnedConnection(ctx, principal, input.defaultConnectionId, deps);

  const existing = await deps.findAuthoredTool(ctx.db, principal.personId, {
    vendor: input.vendor,
    name: input.name,
  });
  if (existing) {
    throw new ServiceError(
      "CONFLICT",
      `A ${input.vendor} tool named ${input.name} already exists`,
      {
        details: { toolId: existing.id },
      },
    );
  }

  return deps.insertAuthoredTool(ctx.db, {
    id: deps.newId(),
    personId: principal.personId,
    vendor: input.vendor,
    name: input.name,
    description: input.description.trim(),
    inputSchema: input.inputSchema,
    readOnly: input.annotations.readOnly,
    destructive: input.annotations.destructive,
    defaultConnectionId: input.defaultConnectionId ?? null,
  });
}

/**
 * The number the tool's next version will carry: one past the latest, one for a tool with none. The
 * publish asks before it writes, because the number names the version's directory in the toolbox
 * (`@graft/toolbox`'s `versionPath`) and the directory is written before the row. `addToolVersion`
 * asks again inside its transaction, so the row's number is read at insert time and not trusted from
 * the caller. Null when the tool is not the person's.
 */
export async function nextVersionNumber(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  deps: ToolDeps,
): Promise<number | null> {
  if (!(await deps.findAuthoredToolById(ctx.db, principal.personId, toolId))) return null;
  const [latest] = await deps.listToolVersions(ctx.db, principal.personId, toolId);
  return (latest?.versionNumber ?? 0) + 1;
}

/**
 * Add a version: the next number after the latest, never a gap and never a reuse. Two publishes
 * racing for the same tool both read the same latest and the unique constraint refuses the second,
 * which surfaces as the database's error rather than a version claiming another's directory.
 */
export async function addToolVersion(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  input: ToolVersionInput,
  deps: ToolDeps,
): Promise<ToolVersionRow> {
  const versionNumber = orNotFound(
    await nextVersionNumber(ctx, principal, toolId, deps),
    "Tool not found",
  );
  return deps.insertToolVersion(ctx.db, {
    id: deps.newId(),
    toolId,
    versionNumber,
    path: input.path,
    sourceHash: input.sourceHash,
    lockfileHash: input.lockfileHash ?? null,
    checkOutput: input.checkOutput,
    dryRunOutcome: input.dryRunOutcome ?? null,
    dryRunAt: input.dryRunAt ?? null,
    writesInvolved: input.writesInvolved ?? false,
    publisherJobId: input.publisherJobId ?? null,
  });
}

/** Move the pointer to a version of the tool. Null when the version is not the tool's. */
export async function moveToolPointer(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  versionId: string,
  deps: ToolDeps,
): Promise<AuthoredToolRow | null> {
  return deps.setCurrentToolVersion(ctx.db, principal.personId, toolId, versionId);
}

/** A republish's changes to the definition — prose, schema, the check's new annotations. */
export async function updateToolDefinition(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  patch: ToolDefinitionPatch,
  deps: ToolDeps,
): Promise<AuthoredToolRow | null> {
  if (patch.description !== undefined) validateDescription(patch.description);
  if (patch.inputSchema !== undefined) validateInputSchema(patch.inputSchema);
  await assertOwnedConnection(ctx, principal, patch.defaultConnectionId, deps);
  const repoPatch: AuthoredToolPatch = {
    ...(patch.description === undefined ? {} : { description: patch.description.trim() }),
    ...(patch.inputSchema === undefined ? {} : { inputSchema: patch.inputSchema }),
    ...(patch.annotations === undefined
      ? {}
      : { readOnly: patch.annotations.readOnly, destructive: patch.annotations.destructive }),
    ...(patch.defaultConnectionId === undefined
      ? {}
      : { defaultConnectionId: patch.defaultConnectionId }),
  };
  return deps.updateAuthoredTool(ctx.db, principal.personId, toolId, repoPatch);
}

/**
 * Make a version the one the tool runs as: the definition becomes the version's — prose, schema,
 * the check's annotations, the binding — and the pointer moves onto it, in one transaction, so a
 * list never shows one version's description over another's schema. The pointer names only a
 * version that passed its dry run (ADR 0012, L0 as amended 2026-09-17): `acquire`'s job publishes
 * without activating, dry-runs the version by id and calls this on the pass; `publishToolVersion`
 * below does it at publish for the by-hand path, where the agent decides. `NOT_FOUND` when the
 * version is not the tool's, or the tool not the person's — `setCurrentToolVersion` moves nothing.
 *
 * **The pointer only moves forward.** Two jobs over one tool can each publish a version and pass;
 * were the older one to activate after the newer, the tool would run older code under the newer
 * job's word that it works. So a candidate whose number is below the current version's is refused
 * as `CONFLICT`, inside the transaction, with both numbers in the message and in `details`
 * (`currentVersionNumber`, `versionNumber`); the same number — activating what is already current
 * — passes, and so does any tool with no current version.
 */
export async function activateToolVersion(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  versionId: string,
  definition: ToolDefinitionPatch,
  deps: ToolDeps,
): Promise<AuthoredToolRow> {
  return ctx.db.transaction(async (tx) => {
    const scoped = { db: tx };
    const candidate = orNotFound(
      await deps.findToolVersion(tx, principal.personId, versionId),
      "Tool version not found",
    );
    if (candidate.toolId !== toolId) throw new ServiceError("NOT_FOUND", "Tool version not found");
    const tool = orNotFound(
      await deps.findAuthoredToolById(tx, principal.personId, toolId),
      "Tool not found",
    );
    const current = tool.currentVersionId
      ? await deps.findToolVersion(tx, principal.personId, tool.currentVersionId)
      : null;
    if (current && current.versionNumber > candidate.versionNumber) {
      throw new ServiceError(
        "CONFLICT",
        `v${current.versionNumber} of ${tool.vendor}/${tool.name} is already current, so v${candidate.versionNumber} cannot become current: the pointer only moves forward`,
        {
          details: {
            currentVersionId: current.id,
            currentVersionNumber: current.versionNumber,
            versionNumber: candidate.versionNumber,
          },
        },
      );
    }
    await updateToolDefinition(scoped, principal, toolId, definition, deps);
    return orNotFound(
      await moveToolPointer(scoped, principal, toolId, versionId, deps),
      "Tool version not found",
    );
  });
}

/**
 * What a publish does to the rows, in one transaction (GRA-18 calls this): a new version, the
 * definition the check produced, the pointer moved — `addToolVersion` then `activateToolVersion`.
 * The version directory is already written by the time this runs; a failure here leaves a
 * directory without a row, which the next publish overwrites, rather than a row without a
 * directory, which a run would trip over.
 */
export async function publishToolVersion(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  version: ToolVersionInput,
  definition: ToolDefinitionPatch,
  deps: ToolDeps,
): Promise<{ tool: AuthoredToolRow; version: ToolVersionRow }> {
  return ctx.db.transaction(async (tx) => {
    const scoped = { db: tx };
    const inserted = await addToolVersion(scoped, principal, toolId, version, deps);
    const tool = await activateToolVersion(
      scoped,
      principal,
      toolId,
      inserted.id,
      definition,
      deps,
    );
    return { tool, version: inserted };
  });
}

/** The person's whole toolbox, demoted tools included — `find_tool`'s search space. */
export async function listTools(
  ctx: ServiceContext,
  principal: Principal,
  deps: ToolDeps,
): Promise<AuthoredToolRow[]> {
  return deps.listAuthoredTools(ctx.db, principal.personId);
}

export async function getToolByName(
  ctx: ServiceContext,
  principal: Principal,
  key: { vendor: string; name: string },
  deps: ToolDeps,
): Promise<AuthoredToolRow | null> {
  return deps.findAuthoredTool(ctx.db, principal.personId, key);
}

export async function getToolById(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  deps: ToolDeps,
): Promise<AuthoredToolRow | null> {
  return deps.findAuthoredToolById(ctx.db, principal.personId, toolId);
}

export async function listToolVersions(
  ctx: ServiceContext,
  principal: Principal,
  toolId: string,
  deps: ToolDeps,
): Promise<ToolVersionRow[]> {
  return deps.listToolVersions(ctx.db, principal.personId, toolId);
}

export async function getToolVersion(
  ctx: ServiceContext,
  principal: Principal,
  versionId: string,
  deps: ToolDeps,
): Promise<ToolVersionRow | null> {
  return deps.findToolVersion(ctx.db, principal.personId, versionId);
}

/** How a dry run of one version ended (ADR 0012, L0). Null when the version is not the person's. */
export async function recordDryRun(
  ctx: ServiceContext,
  principal: Principal,
  versionId: string,
  outcome: { report: Record<string, unknown>; writesInvolved: boolean; at?: Date },
  deps: ToolDeps,
): Promise<ToolVersionRow | null> {
  return deps.recordToolVersionDryRun(ctx.db, principal.personId, versionId, {
    report: outcome.report,
    writesInvolved: outcome.writesInvolved,
    at: outcome.at ?? deps.now(),
  });
}
