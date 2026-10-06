/**
 * The marketing site's setup prompt, one per harness, as `getSetupPrompt(id)` returned it at
 * getmodern-ai/graft-marketing commit 6a6694b7c7b8958ea146201d2fc1db678d520edb
 * (`src/lib/setup-prompt.ts`), copied whole by evaluating that file rather than retyped.
 * `setup-prompt.test.ts` pins `setupPrompt`'s generic form for Graft Cloud to these strings. If
 * the site's copy changes before GRA-211 has the site read `GET /api/setup-prompt`, regenerate
 * this file from the site and name the new commit here; after GRA-211 the copy is this repository's.
 */
export const SITE_SETUP_PROMPTS = {
  claude: `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me https://docs.getgraft.ai/graft/self-hosting/docker-compose and stop; I know what to do from there.

I am using Claude on the web or desktop. If Graft is not connected, give me these steps in a few lines and wait until I say they are done.

Open Customize → Connectors → + → Add custom connector (older interfaces put Connectors under Settings). Name it Graft, enter https://app.getgraft.ai/mcp as the remote MCP server URL, leave the optional OAuth client ID and secret empty, then Add and Connect. On Graft's consent page I sign in or create an account, keep "A new agent" and choose Connect. In the conversation, open + → Connectors and enable Graft.

In a Team or Enterprise workspace, an owner must first add Graft under Organization settings → Connectors; members then connect it individually. Only explain this if the personal add option is unavailable. If Graft's tools are still missing after connecting and enabling it, ask me to start a new chat with Graft enabled and paste this again.

Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`,
  "claude-code": `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me https://docs.getgraft.ai/graft/self-hosting/docker-compose and stop; I know what to do from there.

I am using Claude Code. If Graft is not connected, first check whether a server named graft is already configured without exposing any stored credentials. Reuse it if it points to https://app.getgraft.ai/mcp; do not overwrite a different server or duplicate a working connector. If it is absent, run:
claude mcp add --transport http --scope user graft https://app.getgraft.ai/mcp

Then ask me to run /mcp in my interactive Claude Code session, select Graft and authenticate. If the new server is not listed, ask me to restart Claude Code first. On Graft's consent page I sign in or create an account, keep "A new agent" and choose Connect. Leave optional OAuth client credentials unset; Graft supports automatic client registration. If you cannot run the add command on the machine running my Claude Code client, give me that command to run there.

Wait for me to finish signing in, then check that Graft's tools are available. If needed, reconnect from /mcp or start a new session and paste this again.

Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`,
  codex: `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me https://docs.getgraft.ai/graft/self-hosting/docker-compose and stop; I know what to do from there.

I am using Codex locally in the app, CLI or IDE extension. If Graft is not connected, first check whether a server named graft is already configured without exposing any stored credentials. Reuse it if it points to https://app.getgraft.ai/mcp; do not overwrite a different server. If it is absent, run on the host running my Codex client:
codex mcp add graft --url https://app.getgraft.ai/mcp

If sign-in is still required and the add command has not already started it, run:
codex mcp login graft

Let me complete browser sign-in myself: on Graft's consent page I sign in or create an account, keep "A new agent" and choose Connect. Graft supports automatic OAuth client registration; do not ask me to supply a client ID or secret. If you cannot run these commands on my Codex host, give me the commands to run there. If that host has no Codex CLI, use the app or IDE's MCP servers settings to add a Streamable HTTP server named graft with the same URL and choose Authenticate when offered.

Wait for sign-in to finish, then reload the client or start a fresh session if needed and check for Graft's tools. Editing configuration on an unrelated remote machine or in a hosted web session does not configure my local client.

Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`,
  chatgpt: `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me https://docs.getgraft.ai/graft/self-hosting/docker-compose and stop; I know what to do from there.

I am using ChatGPT on the web or desktop. If Graft is not connected, give me these steps in a few lines and wait until I say they are done.

Open Settings → Security and login and turn Developer mode on. Then open Plugins in the sidebar and choose + → Create app → Create MCP App. Name it Graft, enter https://app.getgraft.ai/mcp as the server URL and keep OAuth: ChatGPT registers itself with Graft, so there is no client ID or secret to enter. Tick "I understand and want to continue" and choose Create. On Graft's consent page I sign in or create an account, keep "A new agent" and choose Connect. In the desktop app that sign-in opens in my browser and ends on a page saying "Authentication complete"; I close that tab and return to ChatGPT. In the conversation, choose + in the message box, type Graft and select it.

If Create does nothing, a Graft app already exists: open Plugins → Personal → Graft and choose + to connect it. In a Business, Enterprise or Edu workspace an admin may have to allow developer mode first; only explain this if Developer mode or Create app is unavailable. If Graft's tools are still missing after connecting and selecting it, ask me to start a new chat with Graft selected and paste this again.

Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`,
  hermes: `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me https://docs.getgraft.ai/graft/self-hosting/docker-compose and stop; I know what to do from there.

I am using Hermes. If Graft is not connected, use my active Hermes profile (normally ~/.hermes; respect HERMES_HOME or a selected profile). Give me the account/token step briefly and wait for me to finish it: sign in at https://app.getgraft.ai, open Agents → New agent, and copy the token shown once into that profile's .env as GRAFT_TOKEN=… myself. Never read that file, print the token or ask me to paste it into chat.

Merge this into the active profile's config.yaml, preserving existing settings and servers. You may make this non-secret configuration change if you have access to the Hermes host; otherwise show it to me:

mcp_servers:
  graft:
    url: "https://app.getgraft.ai/mcp"
    headers:
      Authorization: "Bearer \${GRAFT_TOKEN}"

Keep the environment-variable reference literal in the file. Restart the Hermes session or gateway so it loads the token and configuration, then verify that Graft's tools appear. For config-only changes when the token is already loaded, /reload-mcp can refresh the running session.

Graft's playbook arrives over MCP, so no skill install is needed; if the Graft skill is already installed, follow it too. Hermes shows Graft's approvals as its own cards; everything else follows the handoff rules below.

Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`,
  openclaw: `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me https://docs.getgraft.ai/graft/self-hosting/docker-compose and stop; I know what to do from there.

I am using OpenClaw. If Graft is not connected, check the installed OpenClaw version and the host/profile running my Gateway. Use native outbound MCP configuration under mcp.servers in that profile's OpenClaw config (normally ~/.openclaw/openclaw.json), not a generic top-level mcpServers block. If this version or runtime does not support native Streamable HTTP MCP tools, explain the compatibility blocker and consult https://docs.openclaw.ai/tools/mcp rather than inventing a config location.

Give me the account/token step briefly and wait for me to finish it: sign in at https://app.getgraft.ai, open Agents → New agent, and copy the token shown once into the Gateway host's profile .env (normally ~/.openclaw/.env) as GRAFT_TOKEN=… myself. Never read that file, print the token or ask me to paste it into chat. A token exported only in an unrelated terminal will not reach a running Gateway service.

Merge this into the active OpenClaw config, preserving existing settings and servers. You may make this non-secret configuration change if you have access to the Gateway host; otherwise show it to me:

{
  "mcp": {
    "servers": {
      "graft": {
        "url": "https://app.getgraft.ai/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer \${GRAFT_TOKEN}" }
      }
    }
  }
}

Keep the environment-variable reference literal in the file. Restart the Gateway that owns the conversation so it loads the token; do not mistake reloading a separate CLI process for reloading the Gateway. On versions that provide it, openclaw mcp doctor graft --probe checks the connection. Confirm Graft's tools are actually available in a new agent turn; saving the config alone is not proof. Approval support depends on the runtime, so follow the actual cards or returned URLs using the handoff rules below.

Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`,
  other: `Help me set up Graft and get my first tool built.

Graft is a service that lets an AI agent acquire the tools it lacks. When I ask you for something you have no tool for, Graft reads the service's public documentation, writes a small tool for that one job, tests it against the real service with anything that would change data stopped at Graft's proxy, and adds the tool to your list. My credentials are entered on Graft's own pages and never appear in the tool's code, the sandbox it runs in, or any model.

If you can already see Graft's tools, skip the setup and go straight to using them.

We are using Graft Cloud: hosted, nothing to install, free for a limited time during the alpha. Do not ask me to choose a hosting method. Only ask a setup question if it is necessary to identify the client or resolve a specific blocker. If I say I want to self-host instead, give me https://docs.getgraft.ai/graft/self-hosting/docker-compose and stop; I know what to do from there.

I am using another MCP-compatible agent. If Graft is not connected, identify the client and version from the current environment; if you cannot, ask me only which client I use. Follow that client's official setup instructions and https://docs.getgraft.ai/graft/harnesses/any-mcp-client.md. The client must support remote Streamable HTTP, not just local stdio servers.

Connect to https://app.getgraft.ai/mcp. Prefer MCP OAuth with automatic client registration if supported: I sign in on Graft's consent page, keep "A new agent" and choose Connect. Otherwise I create an agent at https://app.getgraft.ai and store its token through the client's supported secret/environment mechanism myself. Configure an Authorization bearer header without asking for the token in chat. Use the client's own configuration schema and environment-reference syntax; they are not interchangeable across clients.

Preserve existing server settings. Give me only this client's required steps and wait for me to complete sign-in or token entry. Then reload the actual client session and verify Graft's tools are available. If this client cannot use the required transport or authentication, explain that specific blocker instead of claiming setup succeeded.

Once you can see Graft's tools, stop explaining setup and use them. Ask what I want done only if I have not already told you, then call Graft's tools; do not narrate the console or list manual steps. Look for an existing tool before asking Graft to build one, and build only when nothing fits. While Graft is building, relay its newest progress line in a sentence and keep waiting on the same job; if it fails, tell me what Graft reported rather than claiming success.

Connecting a service, confirming it and approving a build each arrive as a card in the chat or a page Graft sends me to. I answer there, never in the chat, and you never answer for me. If Graft says the card is shown, let me use it and repeat the link only if I cannot see it; otherwise send me the exact link with one line saying what it is, and wait. After I say I am done, call the same tool again with the same arguments. Never promise an extra approval step, and never ask me for a key, a token or a password.

When the tool lands, use it to do what I asked and show me the result. If your tool list has not refreshed yet, Graft's run_tool runs it by vendor and name with the input shape it returned; do not guess arguments.

Keep every message short. Explain unfamiliar terms only if I ask.

Docs, if you need them: https://docs.getgraft.ai/llms.txt (an index; every page is available as plain markdown at the linked .md address)`,
} as const;
