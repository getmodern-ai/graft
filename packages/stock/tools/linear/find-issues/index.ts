const SEARCH_ISSUES_QUERY =
  "query SearchIssues($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) { nodes { id identifier title priority url updatedAt state { name type } team { key } assignee { id name } } } }";

const SEARCH_TEAM_ISSUES_QUERY =
  "query SearchTeamIssues($term: String!, $first: Int!, $teamId: ID!) { searchIssues(term: $term, first: $first, filter: { team: { id: { eq: $teamId } } }) { nodes { id identifier title priority url updatedAt state { name type } team { key } assignee { id name } } } }";

type SearchIssue = {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  url: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  team: { key: string } | null;
  assignee: { id: string; name: string } | null;
};

type SearchBody = {
  data?: { searchIssues?: { nodes?: SearchIssue[] } };
  errors?: Array<{ message?: string }>;
};

export default async (input: Input, ctx: Context) => {
  const first = input.first ?? 10;
  let res: Response;

  if (input.teamId !== undefined) {
    const variables = { term: input.term, first, teamId: input.teamId };
    res = await ctx.fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: SEARCH_TEAM_ISSUES_QUERY, variables }),
    });
  } else {
    const variables = { term: input.term, first };
    res = await ctx.fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: SEARCH_ISSUES_QUERY, variables }),
    });
  }

  const body = (await res.json()) as SearchBody;
  const firstError = body.errors?.[0]?.message;
  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${firstError ?? "Linear request failed"}`);
  }
  if (firstError) {
    throw new Error(`Linear GraphQL error: ${firstError}`);
  }

  const issues = body.data?.searchIssues?.nodes ?? [];
  return {
    issues: issues.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      priority: issue.priority,
      url: issue.url,
      updatedAt: issue.updatedAt,
      state: issue.state === null ? null : { name: issue.state.name, type: issue.state.type },
      team: issue.team === null ? null : { key: issue.team.key },
      assignee:
        issue.assignee === null ? null : { id: issue.assignee.id, name: issue.assignee.name },
    })),
  };
};
