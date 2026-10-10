const ALL_WORKFLOW_STATES_QUERY =
  "query ListWorkflowStates { workflowStates(first: 100) { nodes { id name type position team { id key } } } }";

const TEAM_WORKFLOW_STATES_QUERY =
  "query ListTeamWorkflowStates($teamId: ID!) { workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) { nodes { id name type position team { id key } } } }";

type WorkflowState = {
  id: string;
  name: string;
  type: string;
  position: number;
  team: {
    id: string;
    key: string;
  };
};

type GraphQLBody = {
  data?: {
    workflowStates?: {
      nodes?: WorkflowState[];
    };
  };
  errors?: Array<{
    message?: string;
  }>;
};

export default async (input: Input, ctx: Context) => {
  let res: Response;

  if (input.teamId) {
    res = await ctx.fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: TEAM_WORKFLOW_STATES_QUERY,
        variables: { teamId: input.teamId },
      }),
    });
  } else {
    res = await ctx.fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: ALL_WORKFLOW_STATES_QUERY,
        variables: {},
      }),
    });
  }

  const body = (await res.json()) as GraphQLBody;

  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${JSON.stringify(body)}`);
  }

  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }

  const nodes = body.data?.workflowStates?.nodes;
  if (!nodes) {
    throw new Error("Linear GraphQL response did not include workflowStates.nodes");
  }

  return {
    states: nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      position: state.position,
      team: {
        id: state.team.id,
        key: state.team.key,
      },
    })),
  };
};
