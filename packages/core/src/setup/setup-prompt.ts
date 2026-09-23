/**
 * The setup prompt: the message a person pastes into their harness as the first thing they say, so
 * the harness's own model connects itself to Graft and then uses it (GRA-205; GRA-202, "The finish
 * step and the prompt"). One text in three places: Setup's finish step, the console's *Connect a
 * harness* and create dialogs, and `GET /api/setup-prompt`, which the marketing site and the docs
 * read rather than carry a copy (GRA-211).
 *
 * The text began as the marketing site's (`graft-marketing`, `src/lib/setup-prompt.ts`): an
 * introduction, one section per harness, and the next steps. Given only a harness and Graft Cloud's
 * MCP URL, `setupPrompt` answers that text word for word, which `setup-prompt.test.ts` pins against
 * `setup-prompt.site-fixture.ts`. Two things are parameters here that the site wrote in:
 *
 * - **The deployment.** The MCP URL and the console's URL are the caller's, so a self-host's prompt
 *   names its own server. Only a prompt whose MCP URL is on Graft Cloud's origin says "We are using
 *   Graft Cloud"; any other gets the self-hosted sentence, which names the console's URL and never
 *   offers Cloud.
 * - **The person's own agent, connection and tool**, when the caller has them. The consent step
 *   then says to select that agent rather than keep "A new agent", the token step says to use the
 *   token Graft showed for it, and one paragraph before the next steps names the connection and
 *   the tool with a first request built from the tool's goal. Nothing here takes a token: the
 *   inputs have no field for one, and a prompt is text a person pastes into a model.
 *
 * **This module is browser-safe, and the console depends on that**: it imports nothing, so
 * `@graft/core/setup/setup-prompt` is what the console renders with.
 *
 * The harness list below is the site's `SETUP_AGENTS` (ids, labels and descriptions), which the
 * route answers as JSON. It is this file's own until GRA-204's harness data module lands beside it;
 * the two are to be reconciled onto one list keyed by these ids.
 */

/** The harnesses a setup prompt is written for, in the site's order, with the site's words. */
export const SETUP_PROMPT_HARNESSES = [
  { id: "claude", label: "Claude", description: "Web & desktop" },
  { id: "claude-code", label: "Claude Code", description: "Terminal & IDE" },
  { id: "codex", label: "Codex", description: "App, CLI & IDE" },
  { id: "chatgpt", label: "ChatGPT", description: "Web & desktop" },
  { id: "hermes", label: "Hermes", description: "Local agent" },
  { id: "openclaw", label: "OpenClaw", description: "Local agent" },
  { id: "other", label: "Other MCP agent", description: "Any compatible client" },
] as const;

export type SetupPromptHarness = (typeof SETUP_PROMPT_HARNESSES)[number]["id"];

export function isSetupPromptHarness(value: unknown): value is SetupPromptHarness {
  return SETUP_PROMPT_HARNESSES.some((harness) => harness.id === value);
}

/** Graft Cloud's origin: a prompt whose MCP URL is here says Graft Cloud, and no other does. */
export const GRAFT_CLOUD_ORIGIN = "https://app.getgraft.ai";

export type SetupPromptInput = {
  harness: SetupPromptHarness;
  /** This deployment's MCP endpoint: `GRAFT_AUTH_URL`'s origin plus `/mcp`. */
  mcpUrl: string;
  /**
   * Where the person signs in and finds their agents (`GRAFT_CONSOLE_URL`). Defaults to the MCP
   * URL's origin, which is the console's in both forms once built; development serves it apart.
   */
  consoleUrl?: string;
  /** The agent the harness is to run as; its name, never its token. */
  agent?: { name: string };
  /** The connection the agent already has; its display name as the console shows it. */
  connection?: { displayName: string };
  /**
   * The agent's first authored tool: the goal it was acquired for and, once it has landed, its wire
   * name (`<vendor>__<name>`). Without the wire name the prompt says the tool is still arriving.
   */
  tool?: { goal: string; wireName?: string };
};

/** The docs page a person who wants to self-host is sent to from the Cloud prompt. */
const SELF_HOSTING_DOCS = "https://docs.getgraft.ai/graft/self-hosting/docker-compose";

/** What the harness sections say about the deployment and the agent. */
type Terms = {
  mcp: string;
  console: string;
  /** The consent page's choice: `keep "A new agent"`, or `select "<name>"` for the person's agent. */
  consentChoice: string;
  agentName: string | null;
};

function hostingParagraph(cloud: boolean, consoleUrl: string): string {
  if (cloud) {
    return `We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me ${SELF_HOSTING_DOCS} and stop; I know what to do from there.`;
  }
  return `We are using a self-hosted Graft server, already running at ${consoleUrl}; there is nothing to install. Do not ask me to choose a hosting method or suggest Graft Cloud instead. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker.`;
}

function intro(cloud: boolean, consoleUrl: string): string {
  return `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

${hostingParagraph(cloud, consoleUrl)}`;
}

/** The site's token step for Hermes and OpenClaw, or the one for an agent that already has a token. */
function tokenStep(t: Terms, envFile: string): string {
  return t.agentName === null
    ? `Give me the account/token step briefly and wait for me to finish it: sign in at ${t.console}, open Agents → New agent, and copy the token shown once into ${envFile} as GRAFT_TOKEN=… myself.`
    : `Give me the token step briefly and wait for me to finish it: copy the token Graft showed once for the agent "${t.agentName}" into ${envFile} as GRAFT_TOKEN=… myself.`;
}

const HARNESS_SECTIONS: Record<SetupPromptHarness, (t: Terms) => string> = {
  claude(t) {
    return `I am using Claude on the web or desktop. If Graft is not connected, give me these steps in a few lines and wait until I say they are done.

Open Customize → Connectors → + → Add custom connector (older interfaces put Connectors under Settings). Name it Graft, enter ${t.mcp} as the remote MCP server URL, leave the optional OAuth client ID and secret empty, then Add and Connect. On Graft's consent page I sign in or create an account, ${t.consentChoice} and choose Connect. In the conversation, open + → Connectors and enable Graft.

In a Team or Enterprise workspace, an owner must first add Graft under Organization settings → Connectors; members then connect it individually. Only explain this if the personal add option is unavailable. If Graft's tools are still missing after connecting and enabling it, ask me to start a new chat with Graft enabled and paste this again.`;
  },

  chatgpt(t) {
    return `I am using ChatGPT on the web or desktop. If Graft is not connected, give me these steps in a few lines and wait until I say they are done.

Open Settings → Connectors → Advanced settings and turn Developer mode on. Back on Connectors, choose Create: name it Graft, enter ${t.mcp} as the MCP server URL, choose OAuth for authentication, leave the client ID and secret empty, tick the acknowledgement and choose Create. On Graft's consent page I sign in or create an account, ${t.consentChoice} and choose Connect. In the conversation, open the tools menu, choose Developer mode and select Graft.

In a Team, Enterprise or Edu workspace an admin must allow connectors first; only explain this if Developer mode or Create is unavailable. If Graft's tools are still missing after connecting and selecting it, ask me to start a new chat with Graft selected and paste this again.`;
  },

  "claude-code"(t) {
    return `I am using Claude Code. If Graft is not connected, first check whether a server named graft is already configured without exposing any stored credentials. Reuse it if it points to ${t.mcp}; do not overwrite a different server or duplicate a working connector. If it is absent, run:
claude mcp add --transport http --scope user graft ${t.mcp}

Then ask me to run /mcp in my interactive Claude Code session, select Graft and authenticate. If the new server is not listed, ask me to restart Claude Code first. On Graft's consent page I sign in or create an account, ${t.consentChoice} and choose Connect. Leave optional OAuth client credentials unset; Graft supports automatic client registration. If you cannot run the add command on the machine running my Claude Code client, give me that command to run there.

Wait for me to finish signing in, then check that Graft's tools are available. If needed, reconnect from /mcp or start a new session and paste this again.`;
  },

  codex(t) {
    return `I am using Codex locally in the app, CLI or IDE extension. If Graft is not connected, first check whether a server named graft is already configured without exposing any stored credentials. Reuse it if it points to ${t.mcp}; do not overwrite a different server. If it is absent, run on the host running my Codex client:
codex mcp add graft --url ${t.mcp}

If sign-in is still required and the add command has not already started it, run:
codex mcp login graft

Let me complete browser sign-in myself: on Graft's consent page I sign in or create an account, ${t.consentChoice} and choose Connect. Graft supports automatic OAuth client registration; do not ask me to supply a client ID or secret. If you cannot run these commands on my Codex host, give me the commands to run there. If that host has no Codex CLI, use the app or IDE's MCP servers settings to add a Streamable HTTP server named graft with the same URL and choose Authenticate when offered.

Wait for sign-in to finish, then reload the client or start a fresh session if needed and check for Graft's tools. Editing configuration on an unrelated remote machine or in a hosted web session does not configure my local client.`;
  },

  hermes(t) {
    return `I am using Hermes. If Graft is not connected, use my active Hermes profile (normally ~/.hermes; respect HERMES_HOME or a selected profile). ${tokenStep(t, "that profile's .env")} Never read that file, print the token or ask me to paste it into chat.

Merge this into the active profile's config.yaml, preserving existing settings and servers. You may make this non-secret configuration change if you have access to the Hermes host; otherwise show it to me:

mcp_servers:
  graft:
    url: "${t.mcp}"
    headers:
      Authorization: "Bearer \${GRAFT_TOKEN}"

Keep the environment-variable reference literal in the file. Restart the Hermes session or gateway so it loads the token and configuration, then verify that Graft's tools appear. For config-only changes when the token is already loaded, /reload-mcp can refresh the running session.

Graft's playbook arrives over MCP, so no skill install is needed; if the Graft skill is already installed, follow it too. Hermes shows Graft's approvals as its own cards; everything else follows the handoff rules below.`;
  },

  openclaw(t) {
    return `I am using OpenClaw. If Graft is not connected, check the installed OpenClaw version and the host/profile running my Gateway. Use native outbound MCP configuration under mcp.servers in that profile's OpenClaw config (normally ~/.openclaw/openclaw.json), not a generic top-level mcpServers block. If this version or runtime does not support native Streamable HTTP MCP tools, explain the compatibility blocker and consult https://docs.openclaw.ai/tools/mcp rather than inventing a config location.

${tokenStep(t, "the Gateway host's profile .env (normally ~/.openclaw/.env)")} Never read that file, print the token or ask me to paste it into chat. A token exported only in an unrelated terminal will not reach a running Gateway service.

Merge this into the active OpenClaw config, preserving existing settings and servers. You may make this non-secret configuration change if you have access to the Gateway host; otherwise show it to me:

{
  "mcp": {
    "servers": {
      "graft": {
        "url": "${t.mcp}",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer \${GRAFT_TOKEN}" }
      }
    }
  }
}

Keep the environment-variable reference literal in the file. Restart the Gateway that owns the conversation so it loads the token; do not mistake reloading a separate CLI process for reloading the Gateway. On versions that provide it, openclaw mcp doctor graft --probe checks the connection. Confirm Graft's tools are actually available in a new agent turn; saving the config alone is not proof. Approval support depends on the runtime, so follow the actual cards or returned URLs using the handoff rules below.`;
  },

  other(t) {
    return `I am using another MCP-compatible agent. If Graft is not connected, identify the client and version from the current environment; if you cannot, ask me only which client I use. Follow that client's official setup instructions and https://docs.getgraft.ai/graft/harnesses/any-mcp-client.md. The client must support remote Streamable HTTP, not just local stdio servers.

Connect to ${t.mcp}. Prefer MCP OAuth with automatic client registration if supported: I sign in on Graft's consent page, ${t.consentChoice} and choose Connect. ${
      t.agentName === null
        ? `Otherwise I create an agent at ${t.console} and store its token`
        : `Otherwise I store the token Graft showed once for the agent "${t.agentName}"`
    } through the client's supported secret/environment mechanism myself. Configure an Authorization bearer header without asking for the token in chat. Use the client's own configuration schema and environment-reference syntax; they are not interchangeable across clients.

Preserve existing server settings. Give me only this client's required steps and wait for me to complete sign-in or token entry. Then reload the actual client session and verify Graft's tools are available. If this client cannot use the required transport or authentication, explain that specific blocker instead of claiming setup succeeded.`;
  },
};

const NEXT_STEPS = `Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`;

/**
 * The first thing a person might ask for with the tool Setup built: its goal as one sentence,
 * capitalised and closed with a full stop when it has none. Exported so a screen can show it on its
 * own; the personalised prompt carries it too.
 */
export function suggestedFirstSentence(goal: string): string {
  const sentence = goal.trim().replace(/\s+/g, " ");
  if (sentence.length === 0) return "";
  const capitalised = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The paragraph naming what the person already has in Graft; null for the generic prompt. */
function personalParagraph(input: SetupPromptInput): string | null {
  const { agent, connection, tool } = input;
  if (!agent && !connection && !tool) return null;
  const sentences = ["I have already started in Graft's console."];
  if (agent)
    sentences.push(`My agent there is called "${agent.name}", and it is the one to connect.`);
  // After a sentence that named the agent, "it"; otherwise the agent is named here.
  const named = Boolean(agent || connection);
  const toolClause = tool
    ? tool.wireName
      ? `Graft has built ${named ? "it" : "my agent"} the tool ${tool.wireName}`
      : `Graft is still building ${named ? "its" : "my agent's"} first tool`
    : null;
  if (connection) {
    const holder = agent ? "It" : "My agent";
    sentences.push(
      toolClause
        ? `${holder} has a connection to ${connection.displayName}, and ${toolClause}.`
        : `${holder} has a connection to ${connection.displayName}.`,
    );
  } else if (toolClause) {
    sentences.push(`${toolClause}.`);
  }
  const first = tool ? suggestedFirstSentence(tool.goal) : "";
  if (tool && first) {
    sentences.push(`Once you can see Graft's tools, my first request is: ${first}`);
    sentences.push(
      tool.wireName
        ? `Use ${tool.wireName} for it rather than asking Graft to build another.`
        : "If the tool is not in your list yet, Graft is still building it; look for it again before asking Graft to build another.",
    );
  }
  return sentences.join(" ");
}

function isCloud(mcpUrl: string): boolean {
  try {
    return new URL(mcpUrl).origin === GRAFT_CLOUD_ORIGIN;
  } catch {
    return false;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The setup prompt for one harness on one deployment. With only `harness` and Graft Cloud's
 * `mcpUrl` it is the marketing site's text word for word; with `agent`, `connection` or `tool` it is
 * that person's.
 */
export function setupPrompt(input: SetupPromptInput): string {
  const cloud = isCloud(input.mcpUrl);
  const consoleUrl = (input.consoleUrl ?? originOf(input.mcpUrl)).replace(/\/+$/, "");
  const terms: Terms = {
    mcp: input.mcpUrl,
    console: consoleUrl,
    consentChoice: input.agent ? `select "${input.agent.name}"` : 'keep "A new agent"',
    agentName: input.agent?.name ?? null,
  };
  const personal = personalParagraph(input);
  return [
    intro(cloud, consoleUrl),
    HARNESS_SECTIONS[input.harness](terms),
    ...(personal ? [personal] : []),
    NEXT_STEPS,
  ].join("\n\n");
}
