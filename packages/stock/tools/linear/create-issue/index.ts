const QUERY =
  "mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url state { name } } } }";

type GraphQLError = { message?: string };
type Issue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string } | null;
};
type ResponseBody = {
  data?: { issueCreate?: { success: boolean; issue: Issue | null } };
  errors?: GraphQLError[];
};

export default async (input: Input, ctx: Context) => {
  const issueInput: Record<string, unknown> = {
    teamId: input.teamId,
    title: input.title,
  };

  if (input.description !== undefined) issueInput.description = input.description;
  if (input.priority !== undefined) issueInput.priority = input.priority;
  if (input.assigneeId !== undefined) issueInput.assigneeId = input.assigneeId;
  if (input.stateId !== undefined) issueInput.stateId = input.stateId;
  if (input.labelIds !== undefined) issueInput.labelIds = input.labelIds;
  if (input.projectId !== undefined) issueInput.projectId = input.projectId;
  if (input.cycleId !== undefined) issueInput.cycleId = input.cycleId;

  const variables = { input: issueInput };
  const res = await ctx.fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables }),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: variables };
  }
  if (!res.ok) throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as ResponseBody;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }

  const result = body.data?.issueCreate;
  if (!result?.success) throw new Error("Linear issueCreate returned success: false");
  if (!result.issue) throw new Error("Linear issueCreate returned no issue");

  return { created: true, issue: result.issue };
};
