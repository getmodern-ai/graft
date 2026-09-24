import { countSetupWork, findSetup, lockSetup, saveSetup } from "@graft/db/repo/setup";

/**
 * The Setup module's test seam: the record's four statements and the clock. The agent Setup mints
 * or adopts goes through the agent service with its own `AgentDeps`, handed beside these, so this
 * module never writes an agent row itself.
 */
export type SetupDeps = {
  findSetup: typeof findSetup;
  /** The record locked, made first when absent: the start's opening read, so two starts serialise. */
  lockSetup: typeof lockSetup;
  saveSetup: typeof saveSetup;
  /** The person's connections and tools, for the show rule. */
  countSetupWork: typeof countSetupWork;
  now: () => Date;
};

export const defaultSetupDeps: SetupDeps = {
  findSetup,
  lockSetup,
  saveSetup,
  countSetupWork,
  now: () => new Date(),
};
