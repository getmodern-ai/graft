import {
  answerPendingAction,
  consumePendingAction,
  findPendingAction,
  findPendingActionForPerson,
  insertPendingAction,
  listDonePendingActions,
  listOpenPendingActions,
  updatePendingActionPayload,
} from "@graft/db/repo/pending-action";

/** The pending-action module's test seam. */
export type PendingActionDeps = {
  insertPendingAction: typeof insertPendingAction;
  findPendingAction: typeof findPendingAction;
  findPendingActionForPerson: typeof findPendingActionForPerson;
  listOpenPendingActions: typeof listOpenPendingActions;
  /** GRA-292: the Done list, keyset-paged. */
  listDonePendingActions: typeof listDonePendingActions;
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
  listDonePendingActions,
  answerPendingAction,
  consumePendingAction,
  updatePendingActionPayload,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
