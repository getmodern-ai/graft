import { findConnection, findConnectionForUpdate } from "@graft/db/repo/connection";
import {
  findAuthoredTool,
  findAuthoredToolById,
  findToolVersion,
  insertAuthoredTool,
  insertToolVersion,
  listAuthoredTools,
  listToolVersions,
  recordToolVersionDryRun,
  setCurrentToolVersion,
  updateAuthoredTool,
} from "@graft/db/repo/tool";

/** The toolbox module's test seam — the pointer rows and their versions, and the clock. */
export type ToolDeps = {
  insertAuthoredTool: typeof insertAuthoredTool;
  findAuthoredTool: typeof findAuthoredTool;
  findAuthoredToolById: typeof findAuthoredToolById;
  listAuthoredTools: typeof listAuthoredTools;
  updateAuthoredTool: typeof updateAuthoredTool;
  insertToolVersion: typeof insertToolVersion;
  listToolVersions: typeof listToolVersions;
  findToolVersion: typeof findToolVersion;
  setCurrentToolVersion: typeof setCurrentToolVersion;
  recordToolVersionDryRun: typeof recordToolVersionDryRun;
  /** A default connection must be the person's — read to refuse one that is not. */
  findConnection: typeof findConnection;
  /**
   * The default's row locked for the transaction: the rebind of a dead binding reads it through
   * this so a reconnection racing the write waits for it (`rebindToolIfConnectionDead`, GRA-122).
   */
  findConnectionForUpdate: typeof findConnectionForUpdate;
  newId: () => string;
  now: () => Date;
};

export const defaultToolDeps: ToolDeps = {
  insertAuthoredTool,
  findAuthoredTool,
  findAuthoredToolById,
  listAuthoredTools,
  updateAuthoredTool,
  insertToolVersion,
  listToolVersions,
  findToolVersion,
  setCurrentToolVersion,
  recordToolVersionDryRun,
  findConnection,
  findConnectionForUpdate,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
