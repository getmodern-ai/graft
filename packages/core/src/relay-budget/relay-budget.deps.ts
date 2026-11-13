import {
  deleteRelayCallCountsBefore,
  listRelayCallBuckets,
  recordRelayCall,
} from "@graft/db/repo/relay-call";

/** The relay budget's test seam (GRA-349). */
export type RelayBudgetDeps = {
  listRelayCallBuckets: typeof listRelayCallBuckets;
  recordRelayCall: typeof recordRelayCall;
  deleteRelayCallCountsBefore: typeof deleteRelayCallCountsBefore;
  now: () => Date;
};

export const defaultRelayBudgetDeps: RelayBudgetDeps = {
  listRelayCallBuckets,
  recordRelayCall,
  deleteRelayCallCountsBefore,
  now: () => new Date(),
};
