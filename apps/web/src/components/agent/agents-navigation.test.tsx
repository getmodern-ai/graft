// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";
import { routeTree } from "@/routeTree.gen";

// Exercise the generated routes and real drawer, with only auth and shell chrome removed.
vi.mock("@/routes/__root", async () => {
  const { createRootRouteWithContext, Outlet } = await import("@tanstack/react-router");
  return {
    Route: createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet }),
  };
});
vi.mock("@/routes/_auth/route", async () => {
  const { createFileRoute, Outlet } = await import("@tanstack/react-router");
  return { Route: createFileRoute("/_auth")({ component: Outlet }) };
});
vi.mock("@/routes/_auth/_shell/route", async () => {
  const { createFileRoute, Outlet } = await import("@tanstack/react-router");
  return { Route: createFileRoute("/_auth/_shell")({ component: Outlet }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const agent: Agent = {
  id: "agent_1",
  name: "Hermes on laptop",
  tokenPrefix: "grft_abc",
  connectedVia: null,
  scopeMode: "all",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  archivedAt: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
};
const other: Agent = {
  ...agent,
  id: "agent_2",
  name: "Research",
  tokenPrefix: null,
  scopeMode: "listed",
  connectedVia: { clientId: "client_1", clientName: "ChatGPT" },
};
const connection: Connection = {
  id: "conn_1",
  provider: "keyring",
  vendor: "example",
  displayName: "Work account",
  scheme: "none",
  schemeConfig: {},
  primaryHost: "https://api.example.com",
  hosts: ["api.example.com"],
  credentialSetAt: null,
  oauth: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
};
let root: Root;
let client: QueryClient;
let rows: Agent[];
let detailResponse: (value: Agent) => Response | Promise<Response>;
let connectionResponse: () => Response;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  rows = [agent, other];
  detailResponse = (value) => Response.json({ agent: value, connectionIds: [connection.id] });
  connectionResponse = () =>
    Response.json({
      connections: [connection, { ...connection, id: "conn_2", displayName: "Personal account" }],
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/agents?includeArchived=true") return Response.json({ agents: rows });
      if (url === "/api/connections") return connectionResponse();
      if (url === "/api/tools") return Response.json({ tools: [] });
      if (url.startsWith("/api/approvals?")) return Response.json({ approvals: [] });
      if (url.endsWith("/working-set")) return Response.json({ workingSet: [] });
      if (url.includes("/working-set/changes")) return Response.json({ changes: [] });
      const value = rows.find((row) => url === `/api/agents/${row.id}`);
      if (value) return detailResponse(value);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(path = "/agents") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient: client },
    defaultPendingMinMs: 0,
  });
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  return router;
}

async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    check();
  });
}
function dialog() {
  return document.querySelector<HTMLElement>("[role=dialog]");
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button: ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function open(id: string) {
  const link = document.getElementById(`agent-link-${id}`);
  if (!link) throw new Error("Missing agent link");
  await act(async () => {
    link.focus();
    link.click();
  });
  return link;
}

describe("agent drawer navigation", () => {
  it("keeps the list behind a loading drawer, shows both scope connections and returns focus on close", async () => {
    let resolve: (value: Response) => void = () => {};
    detailResponse = () =>
      new Promise<Response>((done) => {
        resolve = done;
      });
    const router = await mount();
    const row = document.getElementById("agent-link-agent_1")?.closest("tr");
    expect(row?.textContent).toContain("Not recorded");
    expect(document.getElementById("agent-link-agent_2")?.closest("tr")?.textContent).toContain(
      "ChatGPT",
    );
    const link = await open(agent.id);
    await waitFor(() => expect(dialog()?.textContent).toContain("Loading details"));
    expect(document.getElementById("new-agent")).not.toBeNull();
    expect(router.state.location.pathname).toBe("/agents/agent_1");
    await act(async () =>
      resolve(Response.json({ agent, connectionIds: [connection.id, "conn_2"] })),
    );
    await waitFor(() => expect(dialog()?.textContent).toContain("Work account"));
    expect(dialog()?.textContent).toContain("Personal account");
    expect(dialog()?.textContent).toContain("Graft has not recorded which harness");
    expect(dialog()?.textContent).not.toContain("—");
    const boxes = [...(dialog()?.querySelectorAll("[role=checkbox]") ?? [])];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.getAttribute("aria-checked")).toBe("true");
      expect(box.getAttribute("aria-disabled")).toBe("true");
    }
    await click("Close");
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it("supports browser back and forward, direct links, and switching agents without keeping a draft", async () => {
    const router = await mount("/agents/agent_1");
    await waitFor(() => expect(document.getElementById("limits-name")).not.toBeNull());
    const input = document.getElementById("limits-name") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Unsaved draft",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await router.navigate({ to: "/agents/$agentId", params: { agentId: other.id } });
    });
    await waitFor(() =>
      expect((document.getElementById("limits-name") as HTMLInputElement)?.value).toBe("Research"),
    );
    expect((document.getElementById("scope-conn_1") as HTMLInputElement)?.checked).toBe(true);
    expect((document.getElementById("scope-conn_2") as HTMLInputElement)?.checked).toBe(false);
    await act(async () => router.history.back());
    await waitFor(() =>
      expect((document.getElementById("limits-name") as HTMLInputElement)?.value).toBe(agent.name),
    );
    await act(async () => router.history.forward());
    await waitFor(() => expect(dialog()?.textContent).toContain("ChatGPT"));
    await click("Close");
    await waitFor(() => expect(dialog()).toBeNull());
    await open(agent.id);
    await waitFor(() => expect(dialog()).not.toBeNull());
    await act(async () => router.history.back());
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => router.history.forward());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("keeps an archived agent's harness, connections and history readable with editing disabled", async () => {
    rows = [{ ...other, revokedAt: agent.createdAt, archivedAt: agent.createdAt }];
    await mount("/agents/agent_2");
    await waitFor(() => expect(dialog()?.textContent).toContain("Work account"));
    expect(dialog()?.textContent).toContain("Archived");
    expect(dialog()?.textContent).toContain("ChatGPT");
    expect(dialog()?.textContent).toContain("History");
    for (const id of [
      "limits-name",
      "limits-cap",
      "limits-idle",
      "scope-mode",
      "scope-conn_1",
      "scope-conn_2",
    ]) {
      expect(document.getElementById(id)?.hasAttribute("disabled")).toBe(true);
    }
    expect(dialog()?.textContent).not.toContain("Revoke agent");
    expect(dialog()?.textContent).not.toContain("Save scope");
  });

  it("retries a failed agent read inside the drawer and isolates a failed connections read", async () => {
    detailResponse = () => Response.json({ message: "Unavailable" }, { status: 500 });
    connectionResponse = () => Response.json({ message: "Unavailable" }, { status: 500 });
    await mount("/agents/agent_1");
    await waitFor(() => expect(dialog()?.textContent).toContain("Could not load this agent."));
    detailResponse = (value) => Response.json({ agent: value, connectionIds: [connection.id] });
    await click("Retry");
    await waitFor(() => expect(dialog()?.textContent).toContain("Could not load the connections."));
    expect(document.getElementById("limits-name")).not.toBeNull();
    expect(dialog()?.textContent).not.toContain("No connections yet");
    connectionResponse = () => Response.json({ connections: [connection] });
    await click("Retry");
    await waitFor(() => expect(dialog()?.textContent).toContain("Work account"));
  });
});
