import {
  answerPendingAction,
  consumePendingAction,
  findPendingAction,
  findPendingActionForPerson,
  insertPendingAction,
  listOpenPendingActions,
  updatePendingActionPayload,
} from "@graft/db/repo/pending-action";

/** The pending-action module's test seam. */
export type PendingActionDeps = {
  insertPendingAction: typeof insertPendingAction;
  findPendingAction: typeof findPendingAction;
  findPendingActionForPerson: typeof findPendingActionForPerson;
  listOpenPendingActions: typeof listOpenPendingActions;
  answerPendingAction: typeof answerPendingAction;
  consumePendingAction: typeof consumePendingAction;
  /** GRA-147: the provider-link fallback rewrites an open ask's payload onto the keyring. */
  updatePendingActionPayload: typeof updatePendingActionPayload;
  newId: () => string;
  now: () => Date;
};

export const defaultPendingActionDeps: PendingActionDeps = {
  insertPendingAction,
  findPendingAction,
  findPendingActionForPerson,
  listOpenPendingActions,
  answerPendingAction,
  consumePendingAction,
  updatePendingActionPayload,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
