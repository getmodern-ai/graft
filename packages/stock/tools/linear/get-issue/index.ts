const QUERY =
  "query GetIssue($id: String!) { issue(id: $id) { id identifier title description url priority priorityLabel createdAt updatedAt state { id name type } assignee { id name } team { id key } project { id name } labels { nodes { id name } } comments(first: 50) { nodes { id body createdAt user { id name } } } } }";

type NamedEntity = {
  id: string;
  name: string;
};

type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  state: (NamedEntity & { type: string }) | null;
  assignee: NamedEntity | null;
  team: { id: string; key: string };
  project: NamedEntity | null;
  labels: { nodes: NamedEntity[] };
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      createdAt: string;
      user: NamedEntity | null;
    }>;
  };
};

type GraphQLResponse = {
  data?: { issue: Issue | null };
  errors?: Array<{ message?: string }>;
};

export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { id: input.id } }),
  });

  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }

  const issue = body.data?.issue;
  if (!issue) {
    throw new Error(`Linear issue not found: ${input.id}`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    state: issue.state,
    assignee: issue.assignee,
    team: issue.team,
    project: issue.project,
    labels: issue.labels.nodes,
    comments: issue.comments.nodes,
  };
};
