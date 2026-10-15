import { countAgentActivity, findAgentLastRun, listActivity } from "@graft/db/repo/activity";

/** The activity reads' test seam (GRA-308): the stream, and the agent page's two figures. */
export type ActivityDeps = {
  listActivity: typeof listActivity;
  countAgentActivity: typeof countAgentActivity;
  findAgentLastRun: typeof findAgentLastRun;
  now: () => Date;
};

export const defaultActivityDeps: ActivityDeps = {
  listActivity,
  countAgentActivity,
  findAgentLastRun,
  now: () => new Date(),
};
