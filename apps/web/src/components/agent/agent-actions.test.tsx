// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { Agent } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";
import { hermesConfigSnippet } from "@/lib/mcp-snippet";
import { type SetupStateData, setupKeys } from "@/lib/setup-queries";
import { AgentActions } from "./agent-actions";
import type { ConnectAgent } from "./agent-card";
import { AgentCards } from "./agent-cards";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const agent: Agent = {
  id: "agent_1",
  name: "Laptop",
  tokenPrefix: "grft_abc",
  connectedVia: null,
  scopeMode: "all",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
};
let root: Root;
let client: QueryClient;
let connectAgent: Mock<ConnectAgent>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  connectAgent = vi.fn<ConnectAgent>();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // The connection dialog reads which agent Setup was told about (GRA-347); none here.
  client.setQueryDefaults(setupKeys.current, { staleTime: Number.POSITIVE_INFINITY });
  client.setQueryData<SetupStateData>(setupKeys.current, {
    setup: null,
    step: "harness",
    show: false,
    agent: null,
    activeAgents: [],
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function control(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No control: ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => control(label).click());
}

async function mount(
  value = agent,
  table = false,
  read: { connections?: Connection[]; connectionsFailed?: boolean } = { connections: [] },
) {
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        {table ? (
          <AgentCards
            agents={[{ ...value, workingSetCount: 5, connectionIds: [], lastActiveAt: null }]}
            connections={read.connections}
            connectionsFailed={read.connectionsFailed}
            pendingActions={[]}
            setup={undefined}
            onAdd={() => {}}
            onConnectAgent={connectAgent}
            isPending={false}
            isError={false}
            error={null}
            retrying={false}
            onRetry={() => {}}
          />
        ) : (
          <AgentActions agent={value} />
        )}
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
}

async function openEdit() {
  const trigger = control("Actions for Laptop");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await click("Edit");
  return trigger;
}

function field(id: string) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) throw new Error(`No field: ${id}`);
  return input;
}

async function change(id: string, value: string) {
  await act(async () => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {});
    check();
  });
}

describe("agent actions", () => {
  it("reopens setup from the menu, copies configuration without a token and restores focus", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await mount();
    const trigger = control("Actions for Laptop");
    await click("Actions for Laptop");
    await click("Connect an agent");
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("YOUR_AGENT_TOKEN");
    expect(dialog?.textContent).not.toContain("—");
    await click("Copy URL");
    expect(copy).toHaveBeenLastCalledWith(`${window.location.origin}/mcp`);
    // Hermes is the default harness (GRA-152), so the configuration copied is its YAML entry.
    await click("Copy configuration");
    expect(copy.mock.calls.at(-1)?.[0]).toBe(hermesConfigSnippet(window.location.origin));
    expect(copy.mock.calls.at(-1)?.[0]).toContain(`url: "${window.location.origin}/mcp"`);
    // The setup prompt follows the harness picked, names the agent, and carries no token (GRA-205).
    await click("Copy prompt");
    const prompt = String(copy.mock.calls.at(-1)?.[0]);
    expect(prompt).toMatch(/^Help me set up Graft and get my first tool built\./);
    expect(prompt).toContain("I am using Hermes.");
    expect(prompt).toContain('copy the token Graft showed once for the agent "Laptop"');
    expect(prompt).toContain(`url: "${window.location.origin}/mcp"`);
    expect(prompt).not.toContain("grft_");
    expect(fetch).not.toHaveBeenCalled();
    await click("Done");
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("hands Connect an agent to the screen from a card, never opening a dialog of its own", async () => {
    await mount({ ...agent, tokenPrefix: null }, true);
    expect(document.body.textContent).toContain("Not recorded");
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Connect Laptop"]',
    );
    if (!trigger) throw new Error("Missing connect trigger");
    expect(trigger.textContent).toBe("Connect its agent");
    await act(async () => trigger.click());
    expect(connectAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "agent_1" }), trigger);
    // The card's menu goes the same way, with the menu's trigger for focus to return to.
    const menu = control("Actions for Laptop");
    await click("Actions for Laptop");
    await click("Connect an agent");
    expect(connectAgent).toHaveBeenLastCalledWith(expect.objectContaining({ id: "agent_1" }), menu);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("says No integrations yet only once the connections are read", async () => {
    await mount(agent, true, {});
    expect(document.body.textContent).not.toContain("No integrations yet");
    expect(document.querySelector('[aria-label="Loading integrations"]')).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await mount(agent, true, { connectionsFailed: true });
    expect(document.body.textContent).toContain("Could not load integrations");
    expect(document.body.textContent).not.toContain("No integrations yet");
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await mount(agent, true);
    expect(document.body.textContent).toContain("No integrations yet");
  });

  it("draws no Connect its agent on a card whose agent holds a token", async () => {
    await mount(agent, true);
    expect(document.querySelector('button[aria-label="Connect Laptop"]')).toBeNull();
    expect(document.body.textContent).toContain("5 tools ready");
  });

  it("shows OAuth connection instructions without a static-token placeholder", async () => {
    await mount({
      ...agent,
      tokenPrefix: null,
      connectedVia: { clientId: "claude", clientName: "Claude" },
    });
    await click("Actions for Laptop");
    await click("Connect an agent");
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("MCP server URL");
    expect(dialog?.textContent).toContain("choose Laptop");
    expect(dialog?.textContent).toContain("OAuth manages the token for you.");
    // The prompt is Claude's, read off the client that consented, and selects this agent (GRA-205).
    expect(dialog?.textContent).toContain("Setup prompt");
    expect(dialog?.textContent).toContain("I am using Claude on the web or desktop.");
    expect(dialog?.textContent).toContain('select "Laptop" and choose Connect');
    control("Copy prompt");
    expect(dialog?.textContent).not.toContain("YOUR_AGENT_TOKEN");
    expect(dialog?.textContent).not.toContain("GRAFT_TOKEN");
  });

  it("offers no connection setup or revoke for a revoked agent, under the Revoked disclosure", async () => {
    await mount({ ...agent, tokenPrefix: null, revokedAt: "2026-09-20T00:00:00Z" }, true);
    expect(document.body.textContent).not.toContain("Laptop");
    await click("Revoked (1)");
    expect(document.querySelector('button[aria-label="Connect Laptop"]')).toBeNull();
    await click("Actions for Laptop");
    const menu = document.querySelector("[role=menu]")?.textContent;
    expect(menu).toContain("View agent");
    expect(menu).not.toContain("Connect an agent");
    expect(menu).not.toContain("Revoke");
  });

  it("revokes from the menu through the same confirmation the agent page opens", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ agent: { ...agent, revokedAt: "2026-09-21T00:00:00Z" } }));
    vi.stubGlobal("fetch", fetch);
    await mount();
    await click("Actions for Laptop");
    await click("Revoke");
    const confirmation = document.querySelector("[role=alertdialog]");
    if (!confirmation) throw new Error("Missing revocation confirmation");
    expect(confirmation.textContent).toContain("Revoke Laptop?");
    await act(async () => {
      [...confirmation.querySelectorAll("button")]
        .find((button) => button.textContent === "Revoke token")
        ?.click();
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, options] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/agents/agent_1/revoke");
    expect(options.method).toBe("POST");
  });

  it("opens with saved values, cancels without saving, restores focus and discards the draft", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await mount();
    const trigger = await openEdit();
    expect(field("edit-agent-name").value).toBe("Laptop");
    expect(field("edit-agent-cap").value).toBe("20");
    expect(field("edit-agent-idle").value).toBe("21");
    expect(field("edit-agent-cap").max).toBe("500");
    expect(field("edit-agent-idle").max).toBe("3650");
    await change("edit-agent-name", "Discard this");
    await click("Cancel");
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(fetch).not.toHaveBeenCalled();
    await openEdit();
    expect(field("edit-agent-name").value).toBe("Laptop");
  });

  it("keeps the draft after failure, prevents closing during save, then saves and refreshes queries", async () => {
    let rejectSave: (error: Error) => void = () => {};
    const pending = new Promise<Response>((_resolve, reject) => {
      rejectSave = reject;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json({ agent: { ...agent, name: "Desktop" } }));
    vi.stubGlobal("fetch", fetch);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await mount();
    const trigger = await openEdit();
    await change("edit-agent-name", "Desktop");
    await change("edit-agent-cap", "7");
    await change("edit-agent-idle", "14");
    await submit();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((control("Cancel") as HTMLButtonElement).disabled).toBe(true));
    expect(field("edit-agent-name").disabled).toBe(true);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    await submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => rejectSave(new Error("offline")));
    await waitFor(() => expect(field("edit-agent-name").disabled).toBe(false));
    expect(field("edit-agent-name").value).toBe("Desktop");
    expect(field("edit-agent-cap").value).toBe("7");
    await submit();
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
    const [url, options] = fetch.mock.calls[1] ?? [];
    expect(url).toBe("/api/agents/agent_1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      name: "Desktop",
      workingSetCap: 7,
      idleWindowDays: 14,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents"] });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not open Edit for a revoked agent", async () => {
    await mount({ ...agent, revokedAt: "2026-09-20T00:00:00Z" });
    await act(async () =>
      control("Actions for Laptop").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(control("Edit").getAttribute("aria-disabled")).toBe("true");
    await click("Edit");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
