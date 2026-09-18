// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { buildChoiceLabel, renderAsk, titleOf } from "./render";
import { type AnswerOutcome, type AskCard, readAnswerOutcome, readAskCard } from "./shape";

/**
 * The card as a person sees it, rendered into a document with no host: which buttons each ask
 * gets, what a click sends, and what replaces the buttons afterwards. The host wiring is
 * `main.ts`, which has nothing of its own to test; the built page is `bundle.test.ts`.
 */

const BUILD: AskCard = {
  pendingActionId: "pa_1",
  kind: "build",
  agentName: "Claude",
  vendor: "demo",
  displayName: "Demo Orders",
  primaryHost: "https://api.demo.example",
  hosts: ["api.demo.example"],
  scheme: "api_key_header",
  takesCredential: true,
  docsUrl: null,
  expiresAt: "2026-09-19T10:00:00.000Z",
  url: "http://console.graft.test/pending/pa_1?t=abc",
  answerable: true,
};

const KEYLESS: AskCard = {
  ...BUILD,
  pendingActionId: "pa_2",
  kind: "connection",
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  primaryHost: "https://api.open-meteo.com/v1",
  hosts: ["api.open-meteo.com"],
  scheme: "none",
  takesCredential: false,
  docsUrl: "https://open-meteo.com/en/docs",
  provider: "keyring",
  providerConnect: "form",
};

const SECRET: AskCard = {
  ...KEYLESS,
  pendingActionId: "pa_3",
  vendor: "acme",
  displayName: "Acme Orders",
  scheme: "api_key_header",
  takesCredential: true,
  answerable: false,
};

/** A connection the person holds through Pipedream, made for another agent (GRA-104). */
const SCOPE: AskCard = {
  ...BUILD,
  pendingActionId: "pa_7",
  kind: "scope",
  vendor: "gmail",
  displayName: "Gmail",
  primaryHost: "https://gmail.googleapis.com",
  hosts: ["gmail.googleapis.com", "www.googleapis.com"],
  scheme: "pipedream_connect_proxy",
  takesCredential: false,
  docsUrl: "https://developers.google.com/gmail/api",
  provider: "pipedream",
};

const CONSOLE_ONLY: AskCard[] = [
  SECRET,
  { ...SECRET, pendingActionId: "pa_4", providerConnect: "link", provider: "pipedream" },
  { ...SECRET, pendingActionId: "pa_5", kind: "credential" },
  { ...SECRET, pendingActionId: "pa_6", kind: "tool", toolName: "acme__create-order" },
];

function handlers(outcome: AnswerOutcome = { ok: true, sentence: "Done." }) {
  return {
    answer: vi.fn(async () => outcome),
    openConsole: vi.fn(async () => {}),
  };
}

const buttons = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((node) => node.textContent);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a build approval", () => {
  it("draws the agent, the connection and its hosts, the reads-only sentence, and Allow and Deny", () => {
    const root = renderAsk(BUILD, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "build", answerable: "true" });
    expect(root.querySelector("h1")?.textContent).toBe(titleOf(BUILD));
    expect(root.textContent).toContain("Claude");
    expect(root.textContent).toContain("Demo Orders");
    expect(root.textContent).toContain("api.demo.example");
    expect(root.textContent).toContain(
      "Reads only, every write previewed, until the first real use, which asks you once.",
    );
    expect(buttons(root)).toEqual(["Deny", "Allow"]);
    expect(root.querySelector("input[type=checkbox]")).toBeNull();
  });

  it("sends { allow: true } on Allow, disables both buttons, and shows the sentence the server answered", async () => {
    const h = handlers({
      ok: true,
      sentence: "Allowed. Claude may build tools against Demo Orders.",
    });
    const root = renderAsk(BUILD, h, document);
    const allow = [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow");
    allow?.click();
    expect([...root.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ allow: true });
    expect(root.querySelectorAll("button")).toHaveLength(0);
    const status = root.querySelector("[role=status]");
    expect(status?.textContent).toBe("Allowed. Claude may build tools against Demo Orders.");
    expect((status as HTMLElement).dataset.tone).toBe("answered");
  });

  it("sends { allow: false } on Deny", async () => {
    const h = handlers();
    const root = renderAsk(BUILD, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Deny")?.click();
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ allow: false });
  });

  it("shows a refusal's message in the refused tone — answered elsewhere, expired — and offers no retry", async () => {
    const h = handlers({
      ok: false,
      reason: "answered",
      message: "This action has already been answered",
    });
    const root = renderAsk(BUILD, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    const status = root.querySelector("[role=status]") as HTMLElement;
    expect(status.textContent).toBe("This action has already been answered");
    expect(status.dataset.tone).toBe("refused");
    expect(root.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows a sentence when the answer call itself fails, pointing at the link in the chat", async () => {
    const h = {
      answer: vi.fn(async () => Promise.reject(new Error("bridge closed"))),
      openConsole: vi.fn(),
    };
    const root = renderAsk(BUILD, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    expect(root.querySelector("[role=status]")?.textContent).toContain("bridge closed");
    expect(root.querySelector("[role=status]")?.textContent).toContain("console");
  });
});

describe("a connection confirmation for a scheme that takes no credential", () => {
  it("draws the proposal, the scheme label, the documentation URL as text, and a checked build choice", () => {
    const root = renderAsk(KEYLESS, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "connection", answerable: "true" });
    expect(root.textContent).toContain("No credential (public API)");
    expect(root.textContent).toContain("https://api.open-meteo.com/v1");
    expect(root.textContent).toContain("https://open-meteo.com/en/docs");
    expect(root.querySelector("a")).toBeNull();
    const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(root.textContent).toContain(buildChoiceLabel(KEYLESS));
    expect(buttons(root)).toEqual(["Decline", "Connect"]);
  });

  it("sends { connect: true, approveBuild } with the box as the person left it", async () => {
    const h = handlers();
    const root = renderAsk(KEYLESS, h, document);
    const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;
    box.checked = false;
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Connect")?.click();
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ connect: true, approveBuild: false });
    expect(box.disabled).toBe(true);

    const again = handlers();
    const second = renderAsk(KEYLESS, again, document);
    [...second.querySelectorAll("button")].find((b) => b.textContent === "Connect")?.click();
    await flush();
    expect(again.answer).toHaveBeenCalledWith({ connect: true, approveBuild: true });
  });

  it("sends { decline: true } on Decline", async () => {
    const h = handlers();
    const root = renderAsk(KEYLESS, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Decline")?.click();
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ decline: true });
  });
});

describe("a scope ask: a connection the person holds that this agent was not given", () => {
  it("asks to let the agent use the connection, names the provider and hosts, says nothing is entered, and offers a checked build choice with Decline and Allow", () => {
    const root = renderAsk(SCOPE, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "scope", answerable: "true" });
    expect(root.querySelector("h1")?.textContent).toBe("Let Claude use Gmail (gmail)?");
    expect(root.textContent).toContain("via pipedream");
    expect(root.textContent).toContain("made for another of your agents");
    expect(root.textContent).toContain("nothing entered");
    expect(root.textContent).toContain("gmail.googleapis.com, www.googleapis.com");
    expect(root.textContent).toContain("https://developers.google.com/gmail/api");
    // No provenance note: nothing here was proposed by the model, the row is the person's.
    expect(root.querySelector(".ask-note")).toBeNull();
    const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(root.textContent).toContain(buildChoiceLabel(SCOPE));
    expect(buttons(root)).toEqual(["Decline", "Allow"]);
  });

  it("sends { allow: true, approveBuild } with the box as the person left it, and freezes the box", async () => {
    const h = handlers();
    const root = renderAsk(SCOPE, h, document);
    const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;
    box.checked = false;
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ allow: true, approveBuild: false });
    expect(box.disabled).toBe(true);
    expect(root.querySelector(".ask-outcome")?.textContent).toBe("Done.");

    const again = handlers();
    const second = renderAsk(SCOPE, again, document);
    [...second.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    expect(again.answer).toHaveBeenCalledWith({ allow: true, approveBuild: true });
  });

  it("sends { allow: false } on Decline, never the connection ask's decline shape", async () => {
    const h = handlers();
    const root = renderAsk(SCOPE, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Decline")?.click();
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ allow: false });
  });

  it("reads off the wire as a scope card", () => {
    expect(readAskCard({ reason: "awaiting_scope", card: SCOPE })).toEqual(SCOPE);
  });
});

describe("an ask the card may not answer", () => {
  for (const card of CONSOLE_ONLY) {
    it(`${card.kind}${card.providerConnect === "link" ? " (link provider)" : ""}: the proposal as text and one button that opens the handoff URL`, async () => {
      const h = handlers();
      const root = renderAsk(card, h, document);
      expect(root.dataset.answerable).toBe("false");
      expect(buttons(root)).toEqual(["Open in the console"]);
      expect(root.querySelector("input")).toBeNull();
      expect(root.textContent).toContain(card.displayName);
      expect(root.textContent).toContain("console");
      root.querySelector("button")?.click();
      await flush();
      expect(h.openConsole).toHaveBeenCalledWith(card.url);
      expect(h.answer).not.toHaveBeenCalled();
    });
  }

  it("names the provider on a link provider's ask and the tool on a tool ask", () => {
    const link = renderAsk(CONSOLE_ONLY[1] as AskCard, handlers(), document);
    expect(link.querySelector("h1")?.textContent).toContain("through pipedream");
    const tool = renderAsk(CONSOLE_ONLY[3] as AskCard, handlers(), document);
    expect(tool.querySelector("h1")?.textContent).toContain("acme__create-order");
  });
});

describe("reading the wire", () => {
  it("reads the card off structuredContent and nothing off a result that is not an ask", () => {
    expect(readAskCard({ reason: "awaiting_approval", card: BUILD })).toEqual(BUILD);
    expect(readAskCard({ status: "connected", connectionId: "c" })).toBeNull();
    expect(readAskCard({ card: { ...BUILD, hosts: "api.demo.example" } })).toBeNull();
    expect(readAskCard(null)).toBeNull();
    expect(readAskCard("text")).toBeNull();
  });

  it("reads the answer's sentence, a refusal's reason and message, and calls anything else a failure", () => {
    expect(readAnswerOutcome({ answered: true, sentence: "Allowed." })).toEqual({
      ok: true,
      sentence: "Allowed.",
    });
    expect(
      readAnswerOutcome({
        error: "refused",
        reason: "expired",
        message: "This action has expired",
      }),
    ).toEqual({ ok: false, reason: "expired", message: "This action has expired" });
    expect(readAnswerOutcome({ error: "internal", message: "Something went wrong" })).toEqual({
      ok: false,
      reason: "failed",
      message: "Something went wrong",
    });
    expect(readAnswerOutcome(undefined)).toMatchObject({ ok: false, reason: "failed" });
  });
});
