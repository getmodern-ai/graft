import {
  countWorkingSet,
  createAcquireJob,
  demoteTool,
  GOAL_MAX_LENGTH,
  getAcquireJob,
  getAgentScope,
  getToolByName,
  HINTS_MAX_LENGTH,
  listTools,
  listWorkingSet,
  promoteTool,
} from "@graft/core";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { type AcquireStarted, acquireStatusOf } from "../acquire/shapes";
import { requireBuildApproval } from "../approval";
import {
  clampTimeout,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_DETACHED_TIMEOUT_SECONDS,
  DETACHED_ADVICE_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_DETACHED_TIMEOUT_SECONDS,
} from "../bounds";
import type { SessionContext } from "../context";
import { isPlainObject, notAvailableYet, toolError, toolRefusal, toolResult } from "../result";
import { runAuthoredTool } from "../run";
import { authoredToolName } from "../tool-names";

/**
 * The fixed meta-tools every agent sees (CONTEXT.md, *Meta-tool*): the front door, `acquire` and
 * `acquire_status` (ADR 0004; the job behind them is `../acquire/job.ts`), the working set's own
 * controls — `find_tool`, `promote`, `demote`, `run_tool` (ADR 0003, ADR 0009) — and the two whose
 * ticket has not landed, present from day one so the list is stable and answering
 * `not_available_yet` with the ticket: `request_connection` and `request_credential` (GRA-28). The
 * advanced set is `authoring.ts`; the per-connection execute tools are `execute.ts`.
 */

export type MetaTool = {
  definition: Tool;
  handle: (args: Record<string, unknown>, session: SessionContext) => Promise<CallToolResult>;
};

export const FIND_TOOL = "find_tool";
export const PROMOTE = "promote";
export const DEMOTE = "demote";
export const RUN_TOOL = "run_tool";
export const ACQUIRE = "acquire";
export const ACQUIRE_STATUS = "acquire_status";
export const REQUEST_CONNECTION = "request_connection";
export const REQUEST_CREDENTIAL = "request_credential";

/** A tool as `find_tool` answers it — enough for `promote`, and the annotations a harness gates on (ADR 0008). */
export type FoundTool = {
  vendor: string;
  name: string;
  tool: string;
  description: string;
  promoted: boolean;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
};

const toolKeyProperties = {
  vendor: {
    type: "string",
    description: 'The vendor slug the tool is authored against, e.g. "unleashed".',
  },
  name: { type: "string", description: 'The tool\'s kebab-case name, e.g. "list-orders".' },
} as const;

function readToolKey(
  args: Record<string, unknown>,
): { vendor: string; name: string } | { error: string } {
  const vendor = typeof args.vendor === "string" ? args.vendor.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!vendor || !name) return { error: "vendor and name must both be non-empty strings" };
  return { vendor, name };
}

const findTool: MetaTool = {
  definition: {
    name: FIND_TOOL,
    description:
      "Search your toolbox — every tool authored for this account, demoted ones included — by vendor, name and description. " +
      "Answers with each tool's vendor and name (what promote, demote and run_tool take), whether it is currently in your working set, and its read-only and destructive hints. " +
      "A tool that is not promoted is one promote call from appearing in your tool list.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words to match against vendor, name and description, case-insensitively.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  handle: async (args, { ctx, principal, scope, deps }) => {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    if (!query) return toolRefusal("input_invalid", "query must be a non-empty string");
    const [tools, workingSet] = await Promise.all([
      listTools(ctx, principal, deps.tool),
      listWorkingSet(ctx, scope, deps.workingSet),
    ]);
    const promoted = new Set(workingSet.map((entry) => entry.toolId));
    // Case-insensitive substring over the three fields, in toolbox order. Ranking — by how recently
    // an agent used the tool, by how many agents hold it — belongs here and reads the ledger and the
    // working-set records (ADR 0009, ADR 0012); the alpha has too few tools per toolbox to need it.
    const hits: FoundTool[] = tools
      .filter((tool) =>
        [tool.vendor, tool.name, authoredToolName(tool.vendor, tool.name), tool.description].some(
          (field) => field.toLowerCase().includes(query),
        ),
      )
      .map((tool) => ({
        vendor: tool.vendor,
        name: tool.name,
        tool: authoredToolName(tool.vendor, tool.name),
        description: tool.description,
        promoted: promoted.has(tool.id),
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
      }));
    return toolResult({
      tools: hits,
      note:
        hits.length === 0
          ? "Nothing in the toolbox matches. acquire authors a new tool against a connection."
          : "promote a tool to add it to your list; run_tool runs one without promoting it.",
    });
  },
};

const promote: MetaTool = {
  definition: {
    name: PROMOTE,
    description:
      "Move a tool from your toolbox into your working set, so it appears in your tool list as <vendor>__<name> with its own schema. " +
      "Your tool list changes; re-fetch it. Answers with the working set's new size.",
    inputSchema: {
      type: "object",
      properties: toolKeyProperties,
      required: ["vendor", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handle: async (args, session) => {
    const key = readToolKey(args);
    if ("error" in key) return toolRefusal("input_invalid", key.error);
    const { ctx, principal, scope, deps, notifier } = session;
    const tool = await getToolByName(ctx, principal, key, deps.tool);
    if (!tool) return toolNotFound(key);
    const change = await promoteTool(ctx, scope, tool.id, "agent", deps.workingSet);
    if (change.changed) notifier.changed(scope.agentId);
    return toolResult({
      tool: authoredToolName(tool.vendor, tool.name),
      promoted: true,
      changed: change.changed,
      workingSetSize: await countWorkingSet(ctx, scope, deps.workingSet),
    });
  },
};

const demote: MetaTool = {
  definition: {
    name: DEMOTE,
    description:
      "Take a tool out of your working set when you no longer need it. It stays in the toolbox, one find_tool and promote away; nothing is deleted. " +
      "Your tool list changes; re-fetch it. Answers with the working set's new size.",
    inputSchema: {
      type: "object",
      properties: toolKeyProperties,
      required: ["vendor", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handle: async (args, session) => {
    const key = readToolKey(args);
    if ("error" in key) return toolRefusal("input_invalid", key.error);
    const { ctx, principal, scope, deps, notifier } = session;
    const tool = await getToolByName(ctx, principal, key, deps.tool);
    if (!tool) return toolNotFound(key);
    const change = await demoteTool(ctx, scope, tool.id, "agent", deps.workingSet);
    if (change.changed) notifier.changed(scope.agentId);
    return toolResult({
      tool: authoredToolName(tool.vendor, tool.name),
      promoted: false,
      changed: change.changed,
      workingSetSize: await countWorkingSet(ctx, scope, deps.workingSet),
    });
  },
};

const runTool: MetaTool = {
  definition: {
    name: RUN_TOOL,
    description:
      "Run a tool from your toolbox by vendor and name, with its input — exactly what calling the tool first-class does, for the turn in which a tool was just published and for a tool that is not promoted. " +
      "The input is validated against the tool's schema. The vendor's answer, or the tool's failure, comes back verbatim. " +
      "With dryRun: true reads reach the vendor for real and every other method stops at the proxy with a preview of the request; the answer is a dry-run report instead of a result, and nothing changes at the vendor. " +
      `For a call expected to take more than about ${DETACHED_ADVICE_SECONDS} seconds, pass detached: true — and timeoutSeconds up to ${MAX_DETACHED_TIMEOUT_SECONDS} (default ${DEFAULT_DETACHED_TIMEOUT_SECONDS}) — and poll the returned processName with wait_for_process. A dry run is always waited for.`,
    inputSchema: {
      type: "object",
      properties: {
        ...toolKeyProperties,
        input: {
          type: "object",
          description:
            "The tool's input, matching its published schema. Omit for a tool that takes nothing.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Dry run (default false): reads real, writes previewed at the proxy, a report in the answer.",
        },
        detached: {
          type: "boolean",
          description:
            "Start the run in the background and return a processName at once; poll it with wait_for_process.",
        },
        timeoutSeconds: {
          type: "integer",
          description: `Seconds before the run is killed. Waiting: default ${DEFAULT_COMMAND_TIMEOUT_SECONDS}, maximum ${MAX_COMMAND_TIMEOUT_SECONDS}. Detached: default ${DEFAULT_DETACHED_TIMEOUT_SECONDS}, maximum ${MAX_DETACHED_TIMEOUT_SECONDS}.`,
          minimum: 1,
          maximum: MAX_DETACHED_TIMEOUT_SECONDS,
        },
      },
      required: ["vendor", "name"],
      additionalProperties: false,
    },
  },
  handle: async (args, { deps, scope, channel }) => {
    const key = readToolKey(args);
    if ("error" in key) return toolRefusal("input_invalid", key.error);
    if (args.input !== undefined && !isPlainObject(args.input)) {
      return toolRefusal("input_invalid", "input must be an object matching the tool's schema");
    }
    const dryRun = args.dryRun === true;
    const detached = args.detached === true && !dryRun;
    const timeoutSeconds = clampTimeout(args.timeoutSeconds, detached);
    const run = await runAuthoredTool(deps, scope, {
      vendor: key.vendor,
      name: key.name,
      input: args.input ?? {},
      mode: { detached, timeoutSeconds, dryRun },
      channel,
    });
    return run.isError ? toolError(run.answer) : toolResult(run.answer);
  },
};

function toolNotFound(key: { vendor: string; name: string }): CallToolResult {
  return toolRefusal(
    "tool_not_found",
    `No tool named ${key.name} for ${key.vendor} is in this toolbox. find_tool searches it.`,
  );
}

/** The line a job carries before its runner has said anything — what `acquire` answers with at once. */
export const FIRST_PROGRESS_LINE =
  "Queued: Graft's model will read the vendor's documentation, draft the tool, prove it with reads, publish and dry-run it, then promote it into your working set. Poll acquire_status with the jobId for progress.";

const acquire: MetaTool = {
  definition: {
    name: ACQUIRE,
    description:
      "Ask Graft to author the tool you lack against one of your connections: its model reads the vendor's documentation, writes the smallest module that makes the call, checks it, proves it with reads, publishes it, dry-runs it, and promotes it into your working set. " +
      "Returns a job at once; acquire_status reports progress, and the tool appears in your list when it is done.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection to author against; it must be in your scope.",
        },
        goal: { type: "string", description: "What the tool must do, in a sentence or two." },
        hints: {
          type: "string",
          description: "Anything you already know: an endpoint, a documentation URL, a field name.",
        },
      },
      required: ["connectionId", "goal"],
      additionalProperties: false,
    },
  },
  /**
   * The door to the loop (ADR 0004). In order: the arguments; the connection in the agent's scope —
   * the same check every run makes, before anything else, and a connection outside it points at
   * `request_connection` (GRA-28); a model to answer at all; the **build approval** (ADR 0008:
   * `acquire` against a connection asks once per agent per connection), through the session's
   * channel, so an unanswered ask returns GRA-23's `awaiting_approval` and the next call finds the
   * answer; then the job row, and the runner woken. The call returns the moment the row exists —
   * the loop is minutes long and a tool call is not (ADR 0004's client-compatibility risk).
   */
  handle: async (args, session) => {
    const connectionId = typeof args.connectionId === "string" ? args.connectionId.trim() : "";
    if (!connectionId) return toolRefusal("input_invalid", "connectionId must be a string");
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!goal || goal.length > GOAL_MAX_LENGTH) {
      return toolRefusal("input_invalid", `goal must be 1 to ${GOAL_MAX_LENGTH} characters`);
    }
    if (args.hints !== undefined && typeof args.hints !== "string") {
      return toolRefusal("input_invalid", "hints must be a string");
    }
    const hints = typeof args.hints === "string" ? args.hints.trim() : "";
    if (hints.length > HINTS_MAX_LENGTH) {
      return toolRefusal("input_invalid", `hints must be at most ${HINTS_MAX_LENGTH} characters`);
    }

    const { ctx, scope, deps, channel } = session;
    const scopeIds = await getAgentScope(ctx, scope, deps.agent);
    if (!scopeIds.includes(connectionId)) {
      return toolRefusal(
        "connection_not_in_scope",
        `Connection ${connectionId} is not in this agent's scope, so nothing can be authored against it. request_connection proposes a new connection for the person to confirm; an existing one is added to the scope in the console.`,
      );
    }
    if (!deps.model) {
      return toolRefusal(
        "acquire_unconfigured",
        "This deployment has no model configured, so Graft cannot author a tool. Say so rather than retrying; the advanced tools (write_file, check_tool, publish_tool) still let you drive the loop yourself.",
      );
    }
    const gate = await requireBuildApproval(ctx, scope, connectionId, deps, channel);
    if (!gate.pass) return toolError(gate.answer);

    const job = await createAcquireJob(
      ctx,
      scope,
      {
        connectionId,
        goal,
        hints: hints || null,
        firstProgressLine: FIRST_PROGRESS_LINE,
      },
      deps.acquireJob,
    );
    deps.acquireRunner?.kick();
    const started: AcquireStarted = {
      jobId: job.id,
      status: job.status === "running" ? "running" : "queued",
      progress: job.progress,
    };
    return toolResult(started);
  },
};

const acquireStatus: MetaTool = {
  definition: {
    name: ACQUIRE_STATUS,
    description:
      "The progress of an acquire job: its status, the lines Graft's model has reported so far, and the tool it published when it is done.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The id acquire returned." } },
      required: ["jobId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  handle: async (args, { ctx, scope, deps }) => {
    const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
    if (!jobId) return toolRefusal("input_invalid", "jobId must be a string");
    const job = await getAcquireJob(ctx, scope, jobId, deps.acquireJob);
    if (!job) {
      return toolRefusal(
        "job_not_found",
        `No acquire job ${jobId} was started by this agent. The id is the one acquire answered with.`,
      );
    }
    return toolResult(acquireStatusOf(job));
  },
};

const requestConnection: MetaTool = {
  definition: {
    name: REQUEST_CONNECTION,
    description:
      "Propose a new connection to a vendor — its hosts, auth scheme, non-secret parameters and the documentation URL you read — and receive a handoff URL. " +
      "The person opens it in the console, confirms what you proposed and enters the secret there; you never see the credential.",
    inputSchema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: 'A kebab-case vendor slug, e.g. "unleashed".' },
        displayName: { type: "string" },
        primaryHost: {
          type: "string",
          description: "The base URL vendor-relative paths resolve against.",
        },
        hosts: {
          type: "array",
          items: { type: "string" },
          description: "Other hosts the connection may reach.",
        },
        scheme: { type: "string", description: "The auth scheme, as the proxy names them." },
        schemeConfig: { type: "object", description: "The scheme's non-secret parameters." },
        docsUrl: {
          type: "string",
          description: "The documentation page you read, so the person can check it.",
        },
      },
      required: ["vendor", "primaryHost", "scheme"],
      additionalProperties: false,
    },
  },
  handle: async () => notAvailableYet("request_connection", "GRA-28"),
};

const requestCredential: MetaTool = {
  definition: {
    name: REQUEST_CREDENTIAL,
    description:
      "Ask the person to enter or re-enter a connection's credential in the console — after a vendor 401, or a rotated key. Returns a handoff URL to relay.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        reason: { type: "string", description: "What the vendor said, so the person knows why." },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  handle: async () => notAvailableYet("request_credential", "GRA-28"),
};

/** In the order the list carries them: the loop's tools first, the stubs beside them. */
export const META_TOOLS: readonly MetaTool[] = [
  acquire,
  acquireStatus,
  findTool,
  promote,
  demote,
  runTool,
  requestConnection,
  requestCredential,
];
