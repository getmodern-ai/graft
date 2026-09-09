import {
  answerPendingAction,
  consumePendingAction,
  findPendingAction,
  findPendingActionForPerson,
  insertPendingAction,
  listOpenPendingActions,
} from "@graft/db/repo/pending-action";

/** The pending-action module's test seam. */
export type PendingActionDeps = {
  insertPendingAction: typeof insertPendingAction;
  findPendingAction: typeof findPendingAction;
  findPendingActionForPerson: typeof findPendingActionForPerson;
  listOpenPendingActions: typeof listOpenPendingActions;
  answerPendingAction: typeof answerPendingAction;
  consumePendingAction: typeof consumePendingAction;
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
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
