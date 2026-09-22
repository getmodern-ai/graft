// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ConnectionDraft,
  type DraftErrors,
  draftFromProposal,
  emptyDraft,
  validateConnectionDraft,
} from "@/lib/connection-form";
import { redirectUriQuery } from "@/lib/oauth-consent";
import { ConnectionForm } from "./connection-form";

const proposal = draftFromProposal({
  vendor: "example",
  displayName: "Example search",
  primaryHost: "https://api.example.com",
  hosts: ["api.example.com"],
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-api-key" },
});
let root: Root;
let client: QueryClient;
const save = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  save.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(redirectUriQuery.queryKey, {
    redirectUri: "https://graft.example.com/api/oauth/callback",
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function Form({
  initial,
  errors = {},
  disabled = false,
}: {
  initial: ConnectionDraft;
  errors?: DraftErrors;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save(validateConnectionDraft(draft));
      }}
    >
      <ConnectionForm
        draft={draft}
        onChange={setDraft}
        errors={errors}
        idPrefix="test"
        disabled={disabled}
      />
      <button type="submit">Connect</button>
    </form>
  );
}

async function mount(initial = proposal, errors: DraftErrors = {}, disabled = false) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Form initial={initial} errors={errors} disabled={disabled} />
      </QueryClientProvider>,
    ),
  );
}

function input(name: string) {
  const element = document.getElementById(`test-${name}`);
  if (!(element instanceof HTMLInputElement)) throw new Error(`No input: ${name}`);
  return element;
}

function section(name: string) {
  return document.getElementById(`test-${name}`)?.closest("fieldset")?.querySelector("legend")
    ?.textContent;
}

function status(name: string) {
  return document.getElementById(`test-${name}-status`)?.textContent ?? null;
}

async function edit(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="Edit ${label}"]`);
  if (!button) throw new Error(`No edit button: ${label}`);
  await act(async () => button.click());
}

async function change(name: string, value: string) {
  await act(async () => {
    const element = input(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function scheme(label: string) {
  const trigger = document.getElementById("test-scheme");
  if (!trigger) throw new Error("No scheme picker");
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.startsWith(label),
  );
  if (!option) throw new Error(`No scheme: ${label}`);
  await act(async () => option.click());
}

describe("connection field entry", () => {
  it("keeps supplied details readable and submits them untouched alongside the entered secret", async () => {
    await mount();
    for (const name of [
      "vendor",
      "displayName",
      "primaryHost",
      "scheme",
      "schemeConfig.headerName",
    ]) {
      expect(input(name).readOnly).toBe(true);
      expect(input(name).disabled).toBe(false);
      expect(status(name)).toBe("Prefilled");
      expect(input(name).tabIndex).toBe(-1);
    }
    expect(status("credential-apiKey")).toBe("To complete");
    expect([...document.querySelectorAll("legend")].map((legend) => legend.textContent)).toEqual([
      "Required fields",
      "Prefilled details",
      "Optional fields",
    ]);
    expect(section("credential-apiKey")).toBe("Required fields");
    expect(section("vendor")).toBe("Prefilled details");
    expect(section("hosts")).toBe("Optional fields");
    expect(document.querySelector("input")?.id).toBe("test-credential-apiKey");
    expect(input("credential-apiKey").type).toBe("password");
    expect(input("credential-apiKey").readOnly).toBe(false);
    expect(input("credential-apiKey").getAttribute("aria-invalid")).toBeNull();
    expect(status("hosts")).toBeNull();
    expect(status("schemeConfig.prefix")).toBeNull();
    await change("credential-apiKey", "test-only-secret");
    expect(status("credential-apiKey")).toBe("Entered");
    expect(section("credential-apiKey")).toBe("Required fields");
    expect(input("credential-apiKey").readOnly).toBe(false);
    expect(document.body.textContent).not.toContain("test-only-secret");
    await act(async () =>
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(save).toHaveBeenCalledWith({
      ok: true,
      value: {
        vendor: proposal.vendor,
        displayName: proposal.displayName,
        primaryHost: proposal.primaryHost,
        hosts: ["api.example.com"],
        scheme: proposal.scheme,
        schemeConfig: { headerName: "x-api-key" },
        credential: { apiKey: "test-only-secret" },
      },
    });
  });

  it("focuses an unlocked default and keeps it editable as the person changes or clears it", async () => {
    await mount();
    await edit("Header name");
    expect(document.activeElement).toBe(input("schemeConfig.headerName"));
    expect(status("schemeConfig.headerName")).toBe("Editing");
    await change("schemeConfig.headerName", "api-key");
    expect(status("schemeConfig.headerName")).toBe("Edited");
    expect(section("schemeConfig.headerName")).toBe("Prefilled details");
    expect(input("schemeConfig.headerName").readOnly).toBe(false);
    await change("schemeConfig.headerName", "");
    expect(status("schemeConfig.headerName")).toBe("To complete");
    expect(input("schemeConfig.headerName").readOnly).toBe(false);
  });

  it("treats the URL starter as incomplete and never locks a newly entered field", async () => {
    await mount(emptyDraft());
    for (const name of [
      "vendor",
      "displayName",
      "primaryHost",
      "schemeConfig.headerName",
      "credential-apiKey",
    ]) {
      expect(status(name)).toBe("To complete");
      expect(input(name).readOnly).toBe(false);
    }
    await change("vendor", "example");
    expect(status("vendor")).toBe("Entered");
    expect(section("vendor")).toBe("Required fields");
    expect(input("vendor").readOnly).toBe(false);
    await change("vendor", "   ");
    expect(status("vendor")).toBe("To complete");
  });

  it("opens a rejected default for correction and links its error to the field", async () => {
    await mount();
    await mount(proposal, { primaryHost: "This host was refused." });
    expect(input("primaryHost").readOnly).toBe(false);
    expect(status("primaryHost")).toBe("Check this");
    expect(input("primaryHost").getAttribute("aria-describedby")).toContain(
      "test-primaryHost-error",
    );
    await change("primaryHost", "https://other.example.com");
    await mount();
    expect(input("primaryHost").readOnly).toBe(false);
    expect(status("primaryHost")).toBe("Edited");
  });

  it("makes new scheme fields editable, highlights OAuth client input, and removes secrets for a public API", async () => {
    await mount();
    await edit("Auth scheme");
    expect(document.activeElement).toBe(document.getElementById("test-scheme"));
    await scheme("OAuth consent");
    expect(status("schemeConfig.clientId")).toBe("To complete");
    expect(section("schemeConfig.clientId")).toBe("Required fields");
    expect(section("schemeConfig.scopes")).toBe("Optional fields");
    expect(status("credential-clientSecret")).toBe("To complete");
    expect(status("schemeConfig.scopes")).toBeNull();
    await scheme("API key in a header");
    expect(input("schemeConfig.headerName").value).toBe("");
    expect(input("schemeConfig.headerName").readOnly).toBe(false);
    expect(status("schemeConfig.headerName")).toBe("To complete");
    await scheme("No credential");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect([...document.querySelectorAll("legend")].map((legend) => legend.textContent)).toEqual([
      "Prefilled details",
      "Optional fields",
    ]);
    expect(document.body.textContent).toContain("This scheme sends no credential.");
  });

  it("keeps supplied OAuth endpoints below the required client id and secret", async () => {
    await mount(
      draftFromProposal({
        vendor: "example",
        displayName: "Example OAuth",
        scheme: "oauth_authorization_code",
        primaryHost: "https://api.example.com",
        hosts: ["api.example.com"],
        schemeConfig: {
          authorizeUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: "read",
        },
      }),
    );
    expect(section("schemeConfig.clientId")).toBe("Required fields");
    expect(section("credential-clientSecret")).toBe("Required fields");
    expect(section("schemeConfig.authorizeUrl")).toBe("Prefilled details");
    expect(section("schemeConfig.tokenUrl")).toBe("Prefilled details");
    expect(section("schemeConfig.scopes")).toBe("Prefilled details");
    expect(document.querySelector("input")?.id).toBe("test-schemeConfig.clientId");
    await change("schemeConfig.clientId", "example-client");
    expect(section("schemeConfig.clientId")).toBe("Required fields");
    await edit("Token URL");
    expect(input("schemeConfig.tokenUrl").readOnly).toBe(false);
    expect(document.activeElement).toBe(input("schemeConfig.tokenUrl"));
  });

  it("keeps optional secret inputs in the optional section and editable", async () => {
    await mount(emptyDraft("snowflake_keypair_jwt"));
    expect(section("credential-privateKey")).toBe("Required fields");
    expect(section("credential-privateKeyPassphrase")).toBe("Optional fields");
    await change("credential-privateKeyPassphrase", "test-only-passphrase");
    expect(section("credential-privateKeyPassphrase")).toBe("Optional fields");
    expect(input("credential-privateKeyPassphrase").readOnly).toBe(false);
  });

  it("disables both Edit and entry while the form is busy", async () => {
    await mount(proposal, {}, true);
    expect(input("credential-apiKey").disabled).toBe(true);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Edit Vendor"]');
    expect(button?.disabled).toBe(true);
    await edit("Vendor");
    expect(input("vendor").readOnly).toBe(true);
  });
});
