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
import { AUTH_SCHEMES } from "@graft/proxy/types";
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
import {
  describeSchemes,
  readConnectionProposal,
  requestConnection,
  requestCredential,
} from "../connection-request";
import type { SessionContext } from "../context";
import { isPlainObject, toolError, toolRefusal, toolResult } from "../result";
import { runAuthoredTool } from "../run";
import { authoredToolName } from "../tool-names";

/**
 * The fixed meta-tools every agent sees (CONTEXT.md, *Meta-tool*): the front door, `acquire` and
 * `acquire_status` (ADR 0004; the job behind them is `../acquire/job.ts`), the working set's own
 * controls — `find_tool`, `promote`, `demote`, `run_tool` (ADR 0003, ADR 0009) — and the two
 * connection handoffs, `request_connection` and `request_credential` (GRA-28;
 * `../connection-request.ts`). The advanced set is `authoring.ts`; the per-connection execute tools
 * are `execute.ts`.
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
      "Call find_tool first, before acquire, whenever a task has no tool in your list. " +
      "It searches the toolbox, every tool authored for this account, demoted ones included, by vendor, name and description. " +
      "Each hit carries vendor and name (what promote, demote and run_tool take), whether it is in your working set, and its read-only and destructive hints. " +
      "A hit that is not promoted is one promote call from your list. When the answer is empty, call request_connection if the vendor has no connection in your scope (an execute__<connectionId> tool in your list names each one), otherwise acquire.",
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
          ? "Nothing in the toolbox matches. If the vendor has a connection in your scope (an execute__<connectionId> tool in your list names it), acquire authors a new tool against it; if not, request_connection comes first."
          : "promote a tool to add it to your list; run_tool runs one without promoting it.",
    });
  },
};

const promote: MetaTool = {
  definition: {
    name: PROMOTE,
    description:
      "Call promote when find_tool found a tool that is not in your working set. " +
      "It appears in your tool list as vendor__name with its own schema, so re-fetch the list, or call it through run_tool until the list refreshes. " +
      "Answers the working set's new size. Nothing is authored.",
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
      "Call demote when you no longer need a tool in your working set, to keep your list short. " +
      "The tool stays in the toolbox, one find_tool and promote away; nothing is deleted. " +
      "Your tool list changes; re-fetch it. Answers the working set's new size.",
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
      "Call run_tool to run a toolbox tool by vendor and name when it is not in your visible list: the turn a tool was just published or promoted, or a client that snapshots the list per conversation. " +
      "Exactly what calling the tool first-class does: the input is validated against the tool's schema, and the vendor's answer, or the tool's failure, comes back verbatim. " +
      "A tool that changes something may answer awaiting_approval with a url on its first call: give the person the link exactly as returned, wait, and call again with the same arguments once they have answered. " +
      "With dryRun: true reads reach the vendor and every other method stops at the proxy with a preview of the request; the answer is a dry-run report and nothing changes at the vendor. " +
      `For a call expected to take more than about ${DETACHED_ADVICE_SECONDS} seconds, pass detached: true and timeoutSeconds up to ${MAX_DETACHED_TIMEOUT_SECONDS} (default ${DEFAULT_DETACHED_TIMEOUT_SECONDS}), then poll the returned processName with wait_for_process. A dry run is always waited for.`,
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
      "Call acquire when find_tool found nothing that covers the task and the vendor has a connection in your scope. " +
      "Graft's model reads the vendor's documentation, writes the smallest module that makes the call, checks it, proves it with reads, publishes it, dry-runs it and promotes it into your working set. " +
      "Answers a jobId at once, before anything is built: poll acquire_status with it and relay progress. " +
      "The first acquire against a connection may answer awaiting_approval with a url: give the person the link exactly as returned, wait, and call acquire again with the same arguments once they have answered. " +
      "Do not start a second acquire for the same goal while one runs.",
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
      "Call acquire_status with the jobId acquire returned, every ten to twenty seconds while the job is queued or running, or when the person asks how it is going. " +
      "Answers status, the progress lines so far, the attempt count and, once the job has settled, result. " +
      "Tell the person a new progress line in one sentence, only when it changed. " +
      "On succeeded, result.tool is the new tool's wire name, vendor__name: call it for the person's request, through run_tool until it is in your list. " +
      "On failed, say what result.failure and result.message say in the person's words and what you will try next; never reach the vendor yourself.",
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

const requestConnectionTool: MetaTool = {
  definition: {
    name: REQUEST_CONNECTION,
    description:
      "Call request_connection when the vendor a task needs has no connection in your scope: no execute__ tool names it and find_tool shows none. " +
      "Propose its hosts, auth scheme, non-secret parameters and the documentation URL you read, and receive a handoff url. " +
      "The person opens it in the console, checks what you proposed, edits it if need be and enters the secret there; you never see the credential, this tool never takes one, and you never ask for one in chat. " +
      "Every host must be a public https host: private, loopback, link-local and cloud-metadata addresses are refused here and again by the proxy. " +
      `Schemes: ${describeSchemes()}. ` +
      "For a public API that documents no credential (Open-Meteo, an open-data endpoint) propose scheme none: the person confirms the connection and enters nothing. Never propose a key scheme with a made-up value for such a vendor — some read the key's presence and answer differently, Open-Meteo with a redirect to its paid host. " +
      "For oauth_authorization_code (Gmail, Slack user tokens, Notion) propose authorizeUrl, tokenUrl and scopes from the vendor's OAuth documentation and leave clientId out: the person registers a client at the vendor with the redirect URI the form shows, enters its id and secret on the form, and completes the consent in a popup; the awaiting answer carries that redirectUri so you can tell them exactly what to paste, and the call answers connected once the tokens are stored. " +
      "On a deployment with a connection provider such as Pipedream, a vendor it covers (Gmail on Graft Cloud) needs no client and no secret: the awaiting answer names the provider, the person presses one button in the console and signs in at the vendor on the provider's page, and the vendor's token stays with the provider — say so instead of the client instructions. " +
      "The call waits a short while for the person; if they have not finished it answers awaiting_connection with the url to relay: give them the link exactly as returned, say what it is for, wait, and call again with the same proposal once they say it is done; the same link comes back until they have, then connected. " +
      "Once connected the connection is in your scope and its execute__<connectionId> tool is in your list. " +
      "A connection the person already has for the same vendor and hosts is never proposed twice: usable and in your scope, it answers connected at once; otherwise the call refuses with connection_exists naming it and the step that keeps it (request_credential, the console's Reconnect, or the person adding it to your scope). " +
      "A rotated or expired credential is request_credential against the existing connection, never a new connection: a new connection is a new row with no scope and no approvals. " +
      "A vendor this deployment's API gateway covers connects with no person step: the call answers connected at once with provider gateway, the gateway holds the credential and the scheme you proposed is not used.",
    inputSchema: {
      type: "object",
      properties: {
        vendor: {
          type: "string",
          description:
            'A kebab-case vendor slug, e.g. "unleashed" — the key tools authored against this connection are bound to.',
        },
        displayName: {
          type: "string",
          description:
            'What the person will see, e.g. "Acme Unleashed (production)". Defaults to the vendor slug.',
        },
        primaryHost: {
          type: "string",
          description:
            'The https base URL vendor-relative paths resolve against, e.g. "https://api.unleashedsoftware.com".',
        },
        hosts: {
          type: "array",
          items: { type: "string" },
          description:
            "Other hostnames the connection may reach (an SDK that spans several hosts); the primary's is included on its own.",
        },
        scheme: {
          type: "string",
          enum: [...AUTH_SCHEMES],
          description:
            "The auth scheme, as the proxy names them — the one the vendor documents. A vendor a provider such as Pipedream covers is connected by that provider instead; you still name the scheme the vendor documents.",
        },
        schemeConfig: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            'The scheme\'s non-secret parameters, e.g. { "headerName": "x-api-key" } for api_key_header. Never a secret.',
        },
        docsUrl: {
          type: "string",
          description: "The documentation page you read, so the person can check it.",
        },
      },
      required: ["vendor", "primaryHost", "scheme"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handle: async (args, { ctx, scope, deps, notifier }) => {
    const input = readConnectionProposal(args);
    if ("error" in input) return toolRefusal("input_invalid", input.error);
    const outcome = await requestConnection(ctx, scope, input, deps, notifier);
    return outcome.isError ? toolError(outcome.answer) : toolResult(outcome.answer);
  },
};

const requestCredentialTool: MetaTool = {
  definition: {
    name: REQUEST_CREDENTIAL,
    description:
      "Call request_credential when a tool's call comes back with the vendor's 401 or 403, or the person says a key was rotated: it asks them to re-enter the connection's credential in the console and answers a handoff url. " +
      "Never ask for the new key in chat. The connection must be in your scope. " +
      "A rotated or expired credential is request_credential against the existing connection, never a new connection: a new connection is a new row with no scope and no approvals. " +
      "The re-entry replaces the credential and changes no approval; a revoked connection is reconnected by it. " +
      "The call waits a short while; if the person has not finished it answers awaiting_credential with the url: give them the link exactly as returned, say what it is for, wait, and call again once they say it is done; the same link comes back until they have, then connected.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description:
            "The connection whose credential the vendor refused — the id in execute__<connectionId>.",
        },
        reason: {
          type: "string",
          description:
            "What the vendor said, in a sentence, so the person knows why; shown as your words.",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handle: async (args, { ctx, scope, deps }) => {
    const connectionId = typeof args.connectionId === "string" ? args.connectionId : "";
    if (!connectionId.trim()) {
      return toolRefusal("input_invalid", "connectionId must be a non-empty string");
    }
    const reason = typeof args.reason === "string" ? args.reason : undefined;
    const outcome = await requestCredential(
      ctx,
      scope,
      { connectionId, ...(reason === undefined ? {} : { reason }) },
      deps,
    );
    return outcome.isError ? toolError(outcome.answer) : toolResult(outcome.answer);
  },
};

/** In the order the list carries them: the loop's tools first, the stubs beside them. */
export const META_TOOLS: readonly MetaTool[] = [
  acquire,
  acquireStatus,
  findTool,
  promote,
  demote,
  runTool,
  requestConnectionTool,
  requestCredentialTool,
];
