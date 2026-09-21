// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/lib/agent-queries";
import { AgentActions } from "./agent-actions";

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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

async function mount(value = agent) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AgentActions agent={value} />
      </QueryClientProvider>,
    ),
  );
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
