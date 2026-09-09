import { findAuthoredToolById } from "@graft/db/repo/tool";
import {
  countWorkingSet,
  deleteWorkingSetEntry,
  findWorkingSetEntry,
  insertWorkingSetChange,
  insertWorkingSetEntry,
  listWorkingSet,
  listWorkingSetChanges,
  touchWorkingSetUsed,
} from "@graft/db/repo/working-set";

/** The working-set module's test seam. */
export type WorkingSetDeps = {
  listWorkingSet: typeof listWorkingSet;
  findWorkingSetEntry: typeof findWorkingSetEntry;
  countWorkingSet: typeof countWorkingSet;
  insertWorkingSetEntry: typeof insertWorkingSetEntry;
  deleteWorkingSetEntry: typeof deleteWorkingSetEntry;
  touchWorkingSetUsed: typeof touchWorkingSetUsed;
  insertWorkingSetChange: typeof insertWorkingSetChange;
  listWorkingSetChanges: typeof listWorkingSetChanges;
  /** A promoted tool must be the person's — read under the person before the insert. */
  findAuthoredToolById: typeof findAuthoredToolById;
  newId: () => string;
  now: () => Date;
};

export const defaultWorkingSetDeps: WorkingSetDeps = {
  listWorkingSet,
  findWorkingSetEntry,
  countWorkingSet,
  insertWorkingSetEntry,
  deleteWorkingSetEntry,
  touchWorkingSetUsed,
  insertWorkingSetChange,
  listWorkingSetChanges,
  findAuthoredToolById,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
