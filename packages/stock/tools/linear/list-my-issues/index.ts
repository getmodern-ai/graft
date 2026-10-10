const OPEN_ISSUES_QUERY =
  'query ListOpenMyIssues($first: Int!) { viewer { assignedIssues(first: $first, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier title priority priorityLabel url updatedAt state { id name type } team { id key } project { id name } } } } }';

const ALL_ISSUES_QUERY =
  "query ListAllMyIssues($first: Int!) { viewer { assignedIssues(first: $first, orderBy: updatedAt) { nodes { id identifier title priority priorityLabel url updatedAt state { id name type } team { id key } project { id name } } } } }";

type Issue = {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  priorityLabel: string;
  url: string;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  project: { id: string; name: string } | null;
};

type GraphQLResponse = {
  data?: { viewer?: { assignedIssues?: { nodes?: Issue[] } } };
  errors?: Array<{ message?: string }>;
};

export default async (input: Input, ctx: Context) => {
  const first = input.first ?? 25;
  const variables = { first };
  let res: Response;

  if (input.includeCompleted ?? false) {
    res = await ctx.fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: ALL_ISSUES_QUERY, variables }),
    });
  } else {
    res = await ctx.fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: OPEN_ISSUES_QUERY, variables }),
    });
  }

  if (!res.ok) throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }

  const nodes = body.data?.viewer?.assignedIssues?.nodes;
  if (!nodes)
    throw new Error("Linear GraphQL response did not include viewer.assignedIssues.nodes");

  return {
    issues: nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      url: issue.url,
      updatedAt: issue.updatedAt,
      state: {
        id: issue.state.id,
        name: issue.state.name,
        type: issue.state.type,
      },
      team: {
        id: issue.team.id,
        key: issue.team.key,
      },
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
    })),
  };
};
