import { DEMO_API_KEY, DEMO_DOCS_URL, DEMO_HOSTNAME, DEMO_ITEMS, DEMO_VENDOR } from "./demo-vendor";
import {
  GITHUB_DOCS_URL,
  GITHUB_HOSTNAME,
  GITHUB_ISSUES,
  GITHUB_TOKEN,
  GITHUB_VENDOR,
  OCTOKIT_PACKAGE,
  OCTOKIT_VERSION,
} from "./github-vendor";
import {
  asksMatchAnnotations,
  checkAccepted,
  credentialNeverRecorded,
  dryRunBeforeAnyAsk,
  firstWriteThroughPublishedTool,
  noVendorHostInCode,
  publishBeforeFirstWrite,
  readsBeforePublish,
  type ScenarioRun,
  type Score,
  sdkBoundToProxy,
  succeeded,
  toolWorks,
  withinBudget,
  writePreviewed,
} from "./scorers";
import { CONN_DEMO, CONN_GITHUB } from "./world";

/**
 * What we hold the model to: three acquisitions against the fake vendors, each scored by the
 * deterministic scorers for the properties GRA-31 names. A read tool, a write tool whose dry run
 * previews the write and whose first real write goes through the published tool after the person's
 * yes, and a tool that needs an SDK and must bind it to the proxy. The goals and hints are what a
 * harness's agent would send: the person's ask in a sentence, and the documentation URL it knows.
 */

export type ToolUseSpec = {
  /** The input the harness calls the published tool with, as the agent would. */
  input: Record<string, unknown>;
  /** What the final answer must be for the tool to count as working; null means it does. */
  expect: (answer: unknown) => string | null;
};

export type Scenario = {
  name: string;
  because: string;
  connectionId: string;
  vendor: string;
  goal: string;
  hints: string;
  /** The package the module is expected to use, placed for the fake sandbox before the job. */
  sdk?: { package: string; version: string };
  use: ToolUseSpec;
  score(run: ScenarioRun, bounds: { maxAttempts: number; tokenCeiling: number }): Score[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const common = (
  run: ScenarioRun,
  bounds: { maxAttempts: number; tokenCeiling: number },
  hosts: string[],
  secrets: string[],
) => [
  succeeded(run),
  withinBudget(run, bounds.maxAttempts, bounds.tokenCeiling),
  checkAccepted(run),
  readsBeforePublish(run),
  publishBeforeFirstWrite(run),
  noVendorHostInCode(run, hosts),
  dryRunBeforeAnyAsk(run),
  asksMatchAnnotations(run),
  toolWorks(run),
  credentialNeverRecorded(run, secrets),
];

export const listItems: Scenario = {
  name: "read: list the items in Demo Orders",
  because:
    "The plainest acquisition: one GET through ctx.fetch, proven with a read, published, dry-run, promoted; the tool answers the vendor's list.",
  connectionId: CONN_DEMO,
  vendor: DEMO_VENDOR,
  goal: "List the items in the Demo Orders catalogue, up to a limit the caller gives.",
  hints: `The API documentation is at ${DEMO_DOCS_URL}. Items are read with GET /items?limit=<n>.`,
  use: {
    input: { limit: 2 },
    expect: (answer) => {
      const items = isRecord(answer) && Array.isArray(answer.items) ? answer.items : null;
      if (!items) return `expected { items: [...] }, got ${JSON.stringify(answer).slice(0, 120)}`;
      if (items.length !== 2) return `expected 2 items for limit 2, got ${items.length}`;
      const first = items[0];
      if (!isRecord(first) || first.id !== DEMO_ITEMS[0]?.id)
        return "the first item is not the vendor's";
      return null;
    },
  },
  score: (run, bounds) => common(run, bounds, [DEMO_HOSTNAME], [DEMO_API_KEY]),
};

export const createOrder: Scenario = {
  name: "write: create an order in Demo Orders",
  because:
    "A write tool: the dry run previews the POST and passes without creating anything; the first real order is created by the agent through the published tool, after the person's one yes.",
  connectionId: CONN_DEMO,
  vendor: DEMO_VENDOR,
  goal: "Create an order in Demo Orders for one item id and a quantity, and return the new order's id and status.",
  hints: `The API documentation is at ${DEMO_DOCS_URL}. Orders are created with POST /orders and a JSON body { itemId, quantity }.`,
  use: {
    input: { itemId: "itm_1", quantity: 2 },
    expect: (answer) => {
      if (!isRecord(answer))
        return `expected an order, got ${JSON.stringify(answer).slice(0, 120)}`;
      if (typeof answer.id !== "string" || !answer.id.startsWith("ord_"))
        return `no order id in ${JSON.stringify(answer).slice(0, 120)}`;
      if (answer.status !== "created") return `status ${String(answer.status)}, expected created`;
      return null;
    },
  },
  score: (run, bounds) => [
    ...common(run, bounds, [DEMO_HOSTNAME], [DEMO_API_KEY]),
    writePreviewed(run, { method: "POST", path: "/orders" }),
    firstWriteThroughPublishedTool(run),
  ],
};

export const githubOpenIssues: Scenario = {
  name: "sdk: list a repository's open issues through @octokit/rest",
  because:
    "A tool that uses an official SDK: the client must be bound to ctx.proxyKey and ctx.proxyBase, the check must accept it, and the vendor must see its own credential on stripped paths, never the capability token.",
  connectionId: CONN_GITHUB,
  vendor: GITHUB_VENDOR,
  goal: "List the open issues of a GitHub repository, given its owner and name, using the official @octokit/rest SDK.",
  hints: `Use the ${OCTOKIT_PACKAGE} SDK at exactly version ${OCTOKIT_VERSION}, declared in a package.json under dependencies. The endpoint is documented at ${GITHUB_DOCS_URL}; the repository to prove it against is getmodern-ai/graft. Return each issue's number, title and url.`,
  sdk: { package: OCTOKIT_PACKAGE, version: OCTOKIT_VERSION },
  use: {
    input: { owner: "getmodern-ai", repo: "graft" },
    expect: (answer) => {
      const list = Array.isArray(answer)
        ? answer
        : isRecord(answer) && Array.isArray(answer.issues)
          ? answer.issues
          : null;
      if (!list) return `expected a list of issues, got ${JSON.stringify(answer).slice(0, 120)}`;
      if (list.length !== GITHUB_ISSUES.length)
        return `expected ${GITHUB_ISSUES.length} issues, got ${list.length}`;
      const first = list[0];
      if (!isRecord(first) || first.number !== GITHUB_ISSUES[0]?.number)
        return "the first issue is not the vendor's";
      return null;
    },
  },
  score: (run, bounds) => [
    ...common(run, bounds, [GITHUB_HOSTNAME], [GITHUB_TOKEN]),
    sdkBoundToProxy(
      run,
      { package: OCTOKIT_PACKAGE, version: OCTOKIT_VERSION },
      { name: "authorization", value: `Bearer ${GITHUB_TOKEN}` },
      "/repos/",
    ),
  ],
};

export const scenarios: Scenario[] = [listItems, createOrder, githubOpenIssues];
