import type {
  GoalProposal,
  GoalProposalRequest,
  ModelAdapter,
  ModelConversation,
  ModelJobContext,
} from "./types";

/**
 * One adapter in front of two: the person's own, when they have brought a key, or the
 * deployment's fixed model (ADR 0014: a fixed model authors in the hosted form, a person may
 * bring their own key to lower the price). The job sees one `ModelAdapter` and the choice is made
 * per job from `context.personId`, so a person's key can only ever answer that person's jobs — the
 * resolver is handed the id of the job's person and nothing else, and there is no path from one
 * job's conversation to another's adapter.
 *
 * The resolution is lazy — on the first `turn`, not at `open` — because the seam's `open` is
 * synchronous and reading a person's key is a database read and a decrypt. `onRoute` says which
 * way each job went, for the boot log and for the test that proves the isolation.
 */

export type ModelRouteResolver = (personId: string) => Promise<ModelAdapter | null>;

export type ModelRoute = {
  jobId: string;
  personId: string;
  /** Whose model answered: the person's own key, or the deployment's fixed model. */
  source: "person" | "fixed";
  adapter: string;
};

export type RoutedModelOptions = {
  fixed: ModelAdapter | null;
  /** The person's own adapter, or null when they have no key of their own. */
  resolve: ModelRouteResolver;
  onRoute?: (route: ModelRoute) => void;
};

export const ROUTED_MODEL_NAME = "routed";

/** Neither the person nor the deployment has a model — what a turn throws; the job records `model_failed`. */
export class ModelUnavailableError extends Error {
  constructor(personId: string) {
    super(
      `No model can answer this job: person ${personId} has no key of their own and the deployment configured no fixed model (GRAFT_MODEL_BACKEND).`,
    );
    this.name = "ModelUnavailableError";
  }
}

export function createRoutedModel(options: RoutedModelOptions): ModelAdapter {
  return {
    name: ROUTED_MODEL_NAME,
    // Setup's goal suggestions (GRA-209) go the way the person's jobs go: their own key's
    // provider, else the fixed model, else none. `onRoute` is a job's and is not told.
    async proposeGoals(request: GoalProposalRequest): Promise<GoalProposal> {
      const own = await options.resolve(request.personId);
      const adapter = own ?? options.fixed;
      if (!adapter?.proposeGoals) {
        return {
          goals: [],
          outcome: "unavailable",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      return adapter.proposeGoals(request);
    },
    open(context: ModelJobContext): ModelConversation {
      let delegate: Promise<ModelConversation> | null = null;
      const resolveOnce = (): Promise<ModelConversation> => {
        delegate ??= (async () => {
          const own = await options.resolve(context.personId);
          const adapter = own ?? options.fixed;
          if (!adapter) throw new ModelUnavailableError(context.personId);
          options.onRoute?.({
            jobId: context.jobId,
            personId: context.personId,
            source: own ? "person" : "fixed",
            adapter: adapter.name,
          });
          return adapter.open(context);
        })();
        return delegate;
      };
      return {
        async turn(situation) {
          const conversation = await resolveOnce();
          return conversation.turn(situation);
        },
      };
    },
  };
}
