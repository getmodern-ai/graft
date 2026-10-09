import type { ToolDeps } from "@graft/core";
import type { AuthoredToolRow, ToolVersionRow } from "@graft/db/repo/tool";

/**
 * `@graft/core`'s tool seam over two arrays — enough of the rows' behaviour for a publish to be
 * followed by a republish in a test without a database: find by (vendor, name), insert, list
 * versions newest first, move the pointer only onto the tool's own version. Not exported from the
 * package's index; the service suite and the Docker suite import it by path, and GRA-19 may.
 */
export type InMemoryToolDeps = ToolDeps & {
  tools: AuthoredToolRow[];
  versions: ToolVersionRow[];
  /** stock version id -> its number, for `listToolVersionOrigins` (the catalogue's join). */
  stockVersionNumbers: Map<string, number>;
  /** Each agent's standing answer by the version it was given for (GRA-245's carry). */
  approvals: { agentId: string; toolId: string; toolVersionId: string | null }[];
};

export function createInMemoryToolDeps(options: { now?: () => Date } = {}): InMemoryToolDeps {
  const now = options.now ?? (() => new Date());
  const tools: AuthoredToolRow[] = [];
  const versions: ToolVersionRow[] = [];
  const stockVersionNumbers = new Map<string, number>();
  const approvals: InMemoryToolDeps["approvals"] = [];
  let counter = 0;
  const own = (personId: string, toolId: string) =>
    tools.find((tool) => tool.id === toolId && tool.personId === personId) ?? null;

  return {
    tools,
    versions,
    stockVersionNumbers,
    approvals,
    newId: () => `id_${++counter}`,
    now,
    insertAuthoredTool: async (_db, input) => {
      const row: AuthoredToolRow = {
        id: input.id,
        personId: input.personId,
        vendor: input.vendor,
        name: input.name,
        description: input.description,
        inputSchema: input.inputSchema,
        currentVersionId: input.currentVersionId ?? null,
        readOnly: input.readOnly,
        destructive: input.destructive,
        defaultConnectionId: input.defaultConnectionId ?? null,
        owner: "person",
        createdAt: now(),
        updatedAt: now(),
      };
      tools.push(row);
      return row;
    },
    findAuthoredTool: async (_db, personId, key) =>
      tools.find(
        (tool) =>
          tool.personId === personId && tool.vendor === key.vendor && tool.name === key.name,
      ) ?? null,
    findAuthoredToolById: async (_db, personId, id) => own(personId, id),
    // One process over two arrays: nothing races, so the lock is the read.
    findAuthoredToolForUpdate: async (_db, personId, id) => own(personId, id),
    listAuthoredTools: async (_db, personId) => tools.filter((tool) => tool.personId === personId),
    updateAuthoredTool: async (_db, personId, id, patch) => {
      const tool = own(personId, id);
      if (!tool) return null;
      Object.assign(tool, patch, { updatedAt: now() });
      return tool;
    },
    insertToolVersion: async (_db, input) => {
      if (
        versions.some(
          (version) =>
            version.toolId === input.toolId && version.versionNumber === input.versionNumber,
        )
      ) {
        throw new Error(
          `duplicate key value violates unique constraint "tool_version_tool_id_version_number_unique"`,
        );
      }
      const row: ToolVersionRow = {
        id: input.id,
        toolId: input.toolId,
        versionNumber: input.versionNumber,
        path: input.path,
        sourceHash: input.sourceHash,
        lockfileHash: input.lockfileHash ?? null,
        checkOutput: input.checkOutput,
        dryRunOutcome: input.dryRunOutcome ?? null,
        dryRunAt: input.dryRunAt ?? null,
        writesInvolved: input.writesInvolved ?? false,
        publisherJobId: input.publisherJobId ?? null,
        stockToolId: input.stockToolId ?? null,
        stockVersionId: input.stockVersionId ?? null,
        owner: "person",
        createdAt: now(),
      };
      versions.push(row);
      return row;
    },
    listToolVersions: async (_db, personId, toolId) =>
      own(personId, toolId)
        ? versions
            .filter((version) => version.toolId === toolId)
            .sort((a, b) => b.versionNumber - a.versionNumber)
        : [],
    // The stock number is the catalogue's, which this seam does not hold: a suite that needs it
    // fills `stockVersionNumbers`.
    listToolVersionOrigins: async (_db, personId, toolId) =>
      versions
        .filter((version) =>
          toolId === undefined
            ? own(personId, version.toolId) !== null
            : version.toolId === toolId && own(personId, toolId) !== null,
        )
        .sort((a, b) => a.toolId.localeCompare(b.toolId) || b.versionNumber - a.versionNumber)
        .map((version) => ({
          toolId: version.toolId,
          versionId: version.id,
          versionNumber: version.versionNumber,
          createdAt: version.createdAt,
          stockToolId: version.stockToolId,
          stockVersionId: version.stockVersionId,
          stockVersionNumber: version.stockVersionId
            ? (stockVersionNumbers.get(version.stockVersionId) ?? null)
            : null,
        })),
    findToolVersion: async (_db, personId, versionId) => {
      const version = versions.find((row) => row.id === versionId) ?? null;
      return version && own(personId, version.toolId) ? version : null;
    },
    setCurrentToolVersion: async (_db, personId, toolId, versionId) => {
      const tool = own(personId, toolId);
      const version = versions.find((row) => row.id === versionId && row.toolId === toolId);
      if (!tool || !version) return null;
      tool.currentVersionId = versionId;
      return tool;
    },
    recordToolVersionDryRun: async (_db, personId, versionId, outcome) => {
      const version = versions.find((row) => row.id === versionId) ?? null;
      if (!version || !own(personId, version.toolId)) return null;
      Object.assign(version, {
        dryRunOutcome: outcome.report,
        dryRunAt: outcome.at,
        writesInvolved: outcome.writesInvolved,
      });
      return version;
    },
    // A live row of the person's: enough for the owned-connection check and for the rebind's
    // locked read (`rebindToolIfConnectionDead`), which a test overrides to read as revoked.
    findConnection: async (_db, personId, id) => ({ id, personId, revokedAt: null }) as never,
    findConnectionForUpdate: async (_db, personId, id) =>
      ({ id, personId, revokedAt: null }) as never,
    carryApprovalsToVersion: async (_db, personId, args) => {
      if (!own(personId, args.toolId)) return [];
      const moved = approvals.filter(
        (row) => row.toolId === args.toolId && row.toolVersionId === args.fromVersionId,
      );
      for (const row of moved) row.toolVersionId = args.toVersionId;
      return moved as never;
    },
  };
}

/** A database handle whose transaction is the same handle: what the publish's row step calls. */
export const fakeDb = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
} as unknown as Parameters<ToolDeps["insertAuthoredTool"]>[0];
