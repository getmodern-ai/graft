const WORKSPACE_QUERY =
  "query ListWorkspaceIssueLabels { issueLabels(first: 100) { nodes { id name color team { key } } } }";

const TEAM_QUERY =
  "query ListTeamIssueLabels($teamId: ID!) { issueLabels(first: 100, filter: { team: { id: { eq: $teamId } } }) { nodes { id name color team { key } } } }";

type LabelNode = {
  id: string;
  name: string;
  color: string;
  team: { key: string } | null;
};

type LinearResponse = {
  data?: {
    issueLabels: {
      nodes: LabelNode[];
    };
  };
  errors?: Array<{ message: string }>;
};

export default async (input: Input, ctx: Context) => {
  const res = input.teamId
    ? await ctx.fetch("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: TEAM_QUERY,
          variables: { teamId: input.teamId },
        }),
      })
    : await ctx.fetch("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: WORKSPACE_QUERY,
          variables: {},
        }),
      });

  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as LinearResponse;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0].message}`);
  }
  if (!body.data) {
    throw new Error("Linear GraphQL response did not include issue label data");
  }

  return {
    labels: body.data.issueLabels.nodes.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      teamKey: label.team?.key ?? null,
    })),
  };
};
