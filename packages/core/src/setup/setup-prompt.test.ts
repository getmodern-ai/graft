import { describe, expect, it } from "vitest";

import {
  GRAFT_CLOUD_ORIGIN,
  isSetupPromptHarness,
  SETUP_PROMPT_HARNESSES,
  setupPrompt,
  suggestedFirstSentence,
} from "./setup-prompt";
import { SITE_SETUP_PROMPTS } from "./setup-prompt.site-fixture";

const CLOUD_MCP = `${GRAFT_CLOUD_ORIGIN}/mcp`;
const SELF_MCP = "https://graft.example.org/mcp";

// The site's list at graft-marketing a3e11165396f092792e56849dc65970d545a08d4, `SETUP_AGENTS`
// with its `icon` dropped: the ids, the order, the names and the descriptions.
const SITE_AGENTS = [
  { id: "claude", name: "Claude", description: "Web & desktop" },
  { id: "claude-code", name: "Claude Code", description: "Terminal & IDE" },
  { id: "codex", name: "Codex", description: "App, CLI & IDE" },
  { id: "chatgpt", name: "ChatGPT", description: "Web & desktop" },
  { id: "hermes", name: "Hermes", description: "Local agent" },
  { id: "openclaw", name: "OpenClaw", description: "Local agent" },
  { id: "other", name: "Other MCP agent", description: "Any compatible client" },
];

describe("the harness list", () => {
  it("is the site's, in its order and words", () => {
    expect(
      SETUP_PROMPT_HARNESSES.map(({ id, label, description }) => ({
        id,
        name: label,
        description,
      })),
    ).toEqual(SITE_AGENTS);
    expect(Object.keys(SITE_SETUP_PROMPTS)).toEqual(SITE_AGENTS.map((agent) => agent.id));
  });

  it("admits the seven ids and nothing else", () => {
    for (const { id } of SETUP_PROMPT_HARNESSES) expect(isSetupPromptHarness(id)).toBe(true);
    for (const value of ["generic", "Claude", "", null, 7]) {
      expect(isSetupPromptHarness(value)).toBe(false);
    }
  });
});

describe("setupPrompt, generic", () => {
  it.each(SETUP_PROMPT_HARNESSES.map((harness) => harness.id))(
    "is the marketing site's text for %s on Graft Cloud",
    (harness) => {
      expect(setupPrompt({ harness, mcpUrl: CLOUD_MCP })).toBe(SITE_SETUP_PROMPTS[harness]);
    },
  );

  it.each(SETUP_PROMPT_HARNESSES.map((harness) => harness.id))(
    "names a self-host's own server and never Graft Cloud's for %s",
    (harness) => {
      const text = setupPrompt({ harness, mcpUrl: SELF_MCP });
      expect(text).not.toContain("app.getgraft.ai");
      expect(text).not.toContain("We are using Graft Cloud");
      expect(text).toContain(
        "We are using a self-hosted Graft server, already running at https://graft.example.org; there is nothing to install.",
      );
      expect(text).toContain(SELF_MCP);
    },
  );

  it("changes nothing but the hosting paragraph and the URLs on a self-host", () => {
    for (const { id } of SETUP_PROMPT_HARNESSES) {
      const cloud = SITE_SETUP_PROMPTS[id].split("\n\n");
      const self = setupPrompt({ harness: id, mcpUrl: SELF_MCP }).split("\n\n");
      expect(self).toHaveLength(cloud.length);
      const differing = cloud.flatMap((paragraph, index) =>
        paragraph.replaceAll(GRAFT_CLOUD_ORIGIN, "https://graft.example.org") === self[index]
          ? []
          : [index],
      );
      // The fourth paragraph is the hosting one.
      expect(differing).toEqual([3]);
    }
  });

  it("points the sign-in at the console where it is served apart from the MCP endpoint", () => {
    const text = setupPrompt({
      harness: "hermes",
      mcpUrl: "http://localhost:3000/mcp",
      consoleUrl: "http://localhost:3001/",
    });
    expect(text).toContain("sign in at http://localhost:3001, open Agents → New agent");
    expect(text).toContain('url: "http://localhost:3000/mcp"');
  });
});

describe("setupPrompt, personalised", () => {
  const agent = { name: "Laptop" };
  const connection = { displayName: "Gmail" };
  const tool = { goal: "list my five most recent unread emails", wireName: "gmail__list_unread" };

  it("names the agent, the connection and the tool, with a first request from the goal", () => {
    const text = setupPrompt({ harness: "claude", mcpUrl: CLOUD_MCP, agent, connection, tool });
    expect(text).toContain(
      `I have already started in Graft's console. My agent there is called "Laptop", and it is the one to connect. It has a connection to Gmail, and Graft has built it the tool gmail__list_unread. Once you can see Graft's tools, my first request is: List my five most recent unread emails. Use gmail__list_unread for it rather than asking Graft to build another.`,
    );
    expect(text).toContain(
      `On Graft's consent page I sign in or create an account, select "Laptop" and choose Connect.`,
    );
    expect(text).not.toContain('keep "A new agent"');
  });

  it("says a tool still building is arriving", () => {
    const text = setupPrompt({
      harness: "codex",
      mcpUrl: CLOUD_MCP,
      agent,
      connection,
      tool: { goal: "What is the weather in Melbourne?" },
    });
    expect(text).toContain(
      "It has a connection to Gmail, and Graft is still building its first tool. Once you can see Graft's tools, my first request is: What is the weather in Melbourne? If the tool is not in your list yet",
    );
  });

  it("keeps the paragraph whole with a part missing", () => {
    expect(setupPrompt({ harness: "other", mcpUrl: CLOUD_MCP, agent })).toContain(
      `I have already started in Graft's console. My agent there is called "Laptop", and it is the one to connect.\n\n`,
    );
    expect(setupPrompt({ harness: "other", mcpUrl: CLOUD_MCP, tool })).toContain(
      "I have already started in Graft's console. Graft has built my agent the tool gmail__list_unread. Once",
    );
    expect(setupPrompt({ harness: "other", mcpUrl: CLOUD_MCP, connection })).toContain(
      "I have already started in Graft's console. My agent has a connection to Gmail.\n\n",
    );
  });

  it("uses the agent's token rather than a new agent's for a token harness", () => {
    const hermes = setupPrompt({ harness: "hermes", mcpUrl: CLOUD_MCP, agent });
    expect(hermes).toContain(
      `Give me the token step briefly and wait for me to finish it: copy the token Graft showed once for the agent "Laptop" into that profile's .env as GRAFT_TOKEN=… myself.`,
    );
    expect(hermes).not.toContain("Agents → New agent");
    const openclaw = setupPrompt({ harness: "openclaw", mcpUrl: CLOUD_MCP, agent });
    expect(openclaw).toContain(
      `copy the token Graft showed once for the agent "Laptop" into the Gateway host's profile .env (normally ~/.openclaw/.env) as GRAFT_TOKEN=… myself.`,
    );
    const other = setupPrompt({ harness: "other", mcpUrl: CLOUD_MCP, agent });
    expect(other).toContain(
      `Otherwise I store the token Graft showed once for the agent "Laptop" through the client's supported secret/environment mechanism myself.`,
    );
  });

  it("never carries a token, whatever the agent record holds", () => {
    // A console `Agent` carries its prefix; the input type has no room for it, and nothing reads it.
    const record = { name: "Laptop", tokenPrefix: "grft_abc123", token: "grft_abc123secret" };
    for (const { id } of SETUP_PROMPT_HARNESSES) {
      const text = setupPrompt({ harness: id, mcpUrl: SELF_MCP, agent: record, connection, tool });
      expect(text).not.toContain("grft_");
    }
  });
});

describe("suggestedFirstSentence", () => {
  it("capitalises the goal and closes it", () => {
    expect(suggestedFirstSentence("  list my   unread emails ")).toBe("List my unread emails.");
    expect(suggestedFirstSentence("Is it raining in Oslo?")).toBe("Is it raining in Oslo?");
    expect(suggestedFirstSentence("gitHub issues assigned to me.")).toBe(
      "GitHub issues assigned to me.",
    );
    expect(suggestedFirstSentence("   ")).toBe("");
  });
});
