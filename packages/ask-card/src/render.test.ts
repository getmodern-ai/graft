// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import {
  buildChoiceLabel,
  type CardHandlers,
  factsOf,
  MODEL_WORDS_NOTE,
  renderAsk,
  renderCard,
  SETUP_BUTTON,
  SETUP_EYEBROW,
  SETUP_OPENED_SENTENCE,
  SETUP_TITLE,
  schemeLabel,
  setupAskAgainOf,
  setupDescriptionOf,
  titleOf,
  WAITING_SENTENCE,
} from "./render";
import {
  type AnswerOutcome,
  type AskCard,
  type AskStatusOutcome,
  readAnswerOutcome,
  readAskCard,
  readAskStatusOutcome,
  readCardData,
  readSetupCard,
  readStartLinkOutcome,
  type SetupCard,
  type StartLinkOutcome,
  withFromCard,
} from "./shape";

/**
 * The card as a person sees it, rendered into a document with no host: which buttons each ask
 * gets, what a click sends, what replaces the buttons afterwards — and, for the asks that send
 * the person elsewhere (GRA-117, GRA-118), what is opened and how the card settles once
 * `ask_status` says the page did its work. The host wiring is `main.ts`, which has nothing of its
 * own to test; the built page is `bundle.test.ts`.
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

/** A connection the person holds through a link provider, made for another agent (GRA-104). */
const SCOPE: AskCard = {
  ...BUILD,
  pendingActionId: "pa_7",
  kind: "scope",
  vendor: "gmail",
  displayName: "Gmail",
  primaryHost: "https://gmail.googleapis.com",
  hosts: ["gmail.googleapis.com", "www.googleapis.com"],
  scheme: "relay",
  takesCredential: false,
  docsUrl: "https://developers.google.com/gmail/api",
  provider: "broker",
};

/** A write's first-use approval (GRA-116), with the tool's facts as the console's card has them. */
const TOOL: AskCard = {
  ...BUILD,
  pendingActionId: "pa_6",
  kind: "tool",
  toolName: "demo__create-order",
  tool: {
    description: "Creates a sales order at Demo from a customer id and lines.",
    readOnly: false,
    destructive: false,
    askEveryCall: false,
  },
};

/** Gmail through a link provider (GRA-117): started from the card, answered by the link's return. */
const LINK: AskCard = {
  ...SECRET,
  pendingActionId: "pa_4",
  vendor: "gmail",
  displayName: "Gmail",
  primaryHost: "https://gmail.googleapis.com",
  hosts: ["gmail.googleapis.com", "www.googleapis.com"],
  scheme: "oauth_authorization_code",
  providerConnect: "link",
  provider: "broker",
};

const CREDENTIAL: AskCard = { ...SECRET, pendingActionId: "pa_5", kind: "credential" };

/** The asks whose one button opens the console (GRA-118). */
const CONSOLE_ONLY: AskCard[] = [SECRET, CREDENTIAL];

type Outcomes = {
  answer?: AnswerOutcome;
  startLink?: StartLinkOutcome;
  status?: AskStatusOutcome | AskStatusOutcome[];
};

/**
 * Handlers over canned outcomes, polling every millisecond. `status` may be a list, answered in
 * order and the last repeated, so a test can hold the ask open for a tick and then settle it.
 */
function handlers(outcomes: Outcomes = {}) {
  const statuses = Array.isArray(outcomes.status)
    ? [...outcomes.status]
    : [outcomes.status ?? { ok: true, state: "answered", sentence: "Connected." }];
  const controller = new AbortController();
  const h = {
    answer: vi.fn(
      async (): Promise<AnswerOutcome> => outcomes.answer ?? { ok: true, sentence: "Done." },
    ),
    openLink: vi.fn(async (_url: string) => {}),
    startLink: vi.fn(
      async (): Promise<StartLinkOutcome> =>
        outcomes.startLink ?? {
          ok: true,
          url: "https://broker.fake/connect/ltok_1",
          expiresAt: "2026-09-19T10:15:00.000Z",
          provider: "broker",
        },
    ),
    status: vi.fn(async (_id: string) => {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return next as AskStatusOutcome;
    }),
    signal: controller.signal,
    pollMs: 1,
    stop: () => controller.abort(),
  } satisfies CardHandlers & { stop: () => void };
  return h;
}

const buttons = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((node) => node.textContent);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait until `predicate` holds, a tick at a time; the polls run on 1 ms timers. */
async function until(predicate: () => boolean, ticks = 200) {
  for (let i = 0; i < ticks; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the card never settled");
}

const status = (root: HTMLElement) => root.querySelector("[role=status]") as HTMLElement | null;

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
      answer: { ok: true, sentence: "Allowed. Claude may build tools against Demo Orders." },
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
      answer: { ok: false, reason: "answered", message: "This action has already been answered" },
    });
    const root = renderAsk(BUILD, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    expect(status(root)?.textContent).toBe("This action has already been answered");
    expect(status(root)?.dataset.tone).toBe("refused");
    expect(root.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the console button under a card_not_available refusal, and that button opens the handoff URL with from=card and polls", async () => {
    const h = handlers({
      answer: {
        ok: false,
        reason: "card_not_available",
        message: "The ask card answers only for an agent connected from a chat product.",
      },
    });
    const root = renderAsk(BUILD, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    expect(status(root)?.dataset.tone).toBe("refused");
    expect(buttons(root)).toEqual(["Open in the console"]);
    root.querySelector("button")?.click();
    await until(() => status(root)?.dataset.tone === "answered");
    expect(h.openLink).toHaveBeenCalledWith(withFromCard(BUILD.url));
    expect(h.openLink.mock.calls[0]?.[0]).toContain("from=card");
    expect(status(root)?.textContent).toBe("Connected.");
    h.stop();
  });

  it("shows a sentence when the answer call itself fails, pointing at the link in the chat", async () => {
    const h = {
      ...handlers(),
      answer: vi.fn(async () => Promise.reject(new Error("bridge closed"))),
    };
    const root = renderAsk(BUILD, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    expect(status(root)?.textContent).toContain("bridge closed");
    expect(status(root)?.textContent).toContain("console");
  });
});

describe("a tool's first-use approval (GRA-116)", () => {
  it("asks to allow the run, quotes the description as the model's words, names the tool and what it does, and offers Deny and Allow", () => {
    const root = renderAsk(TOOL, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "tool", answerable: "true" });
    expect(root.querySelector("h1")?.textContent).toBe("Allow Claude to run demo__create-order?");
    expect(root.textContent).toContain("changes data at the vendor");
    expect(root.textContent).toContain("Your answer holds for this agent's next calls");
    expect(root.querySelector(".ask-quote blockquote")?.textContent).toBe(TOOL.tool?.description);
    expect(root.querySelector(".ask-badge")?.textContent).toBe(MODEL_WORDS_NOTE);
    expect(root.textContent).toContain("Changes data");
    expect(root.textContent).toContain("Demo Orders");
    expect(root.textContent).toContain("api.demo.example");
    expect(root.querySelector("input[type=checkbox]")).toBeNull();
    expect(buttons(root)).toEqual(["Deny", "Allow"]);
  });

  it("says when the tool is destructive, and when it is set to ask every time", () => {
    const destructive = renderAsk(
      { ...TOOL, tool: { ...(TOOL.tool as NonNullable<AskCard["tool"]>), destructive: true } },
      handlers(),
      document,
    );
    expect(destructive.textContent).toContain("can delete or overwrite data");
    expect(destructive.textContent).toContain("Destructive: can delete or overwrite data");
    const everyCall = renderAsk(
      { ...TOOL, tool: { ...(TOOL.tool as NonNullable<AskCard["tool"]>), askEveryCall: true } },
      handlers(),
      document,
    );
    expect(everyCall.textContent).toContain("ask every time, so a yes is for this call alone");
  });

  it("sends { allow: true } on Allow and { allow: false } on Deny, never the setting", async () => {
    const h = handlers({ answer: { ok: true, sentence: "Allowed. Claude may run it." } });
    const root = renderAsk(TOOL, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Allow")?.click();
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ allow: true });
    expect(status(root)?.textContent).toBe("Allowed. Claude may run it.");

    const again = handlers();
    const second = renderAsk(TOOL, again, document);
    [...second.querySelectorAll("button")].find((b) => b.textContent === "Deny")?.click();
    await flush();
    expect(again.answer).toHaveBeenCalledWith({ allow: false });
  });

  it("reads off the wire with the tool's facts, and drops a tool block of the wrong shape", () => {
    expect(readAskCard({ reason: "awaiting_approval", card: TOOL })).toEqual(TOOL);
    const { tool: _tool, ...bare } = TOOL;
    expect(readAskCard({ card: { ...TOOL, tool: { description: 1 } } })).toEqual(bare);
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

describe("a widening: a keyless connection the person holds, asked to reach another host (GRA-167)", () => {
  const WIDEN: AskCard = {
    ...KEYLESS,
    pendingActionId: "pa_w",
    hosts: ["api.open-meteo.com", "customer-api.open-meteo.com"],
    widens: { connectionId: "conn_om", addedHosts: ["customer-api.open-meteo.com"] },
  };

  it("asks to also reach the added host, says no new connection is made, lists what is added, and offers the checked build choice", () => {
    const root = renderAsk(WIDEN, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "connection", answerable: "true" });
    expect(root.querySelector("h1")?.textContent).toBe(
      "Also reach customer-api.open-meteo.com with Open-Meteo (open-meteo)?",
    );
    expect(root.querySelector(".ask-description")?.textContent).toContain(
      "no new connection is made",
    );
    const facts = [...root.querySelectorAll(".ask-facts dt")].map((node) => node.textContent);
    expect(facts).toContain("Adds");
    expect(root.textContent).toContain("customer-api.open-meteo.com");
    expect(root.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked).toBe(true);
  });

  it("reads off the wire with the widening, and drops one of the wrong shape", () => {
    expect(readAskCard({ card: WIDEN })).toEqual(WIDEN);
    const { widens: _dropped, ...bare } = WIDEN;
    expect(readAskCard({ card: { ...WIDEN, widens: { connectionId: 1 } } })).toEqual(bare);
  });
});

describe("a scope ask: a connection the person holds that this agent was not given", () => {
  it("asks to let the agent use the connection, names the provider and hosts, says nothing is entered, and offers a checked build choice with Decline and Allow", () => {
    const root = renderAsk(SCOPE, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "scope", answerable: "true" });
    expect(root.querySelector("h1")?.textContent).toBe("Let Claude use Gmail (gmail)?");
    expect(root.textContent).toContain("via broker");
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

/**
 * The asks with a secret in them (GRA-118): the console is where it is typed (ADR 0004), the card
 * opens that page with `from=card` and waits on `ask_status` until the page has stored it.
 */
describe("an ask with a secret in it", () => {
  for (const card of CONSOLE_ONLY) {
    it(`${card.kind}: the proposal as text and one button, Enter the secret in Graft, which opens the handoff URL with from=card and polls until answered`, async () => {
      const h = handlers({
        status: [
          { ok: true, state: "open", sentence: "Still waiting." },
          {
            ok: true,
            state: "answered",
            sentence: "Connected; the credential is stored and never shown again.",
          },
        ],
      });
      const root = renderAsk(card, h, document);
      expect(root.dataset.answerable).toBe("false");
      expect(buttons(root)).toEqual(["Enter the secret in Graft"]);
      expect(root.querySelector("input")).toBeNull();
      expect(root.textContent).toContain(card.displayName);
      expect(root.textContent).toContain("console");
      root.querySelector("button")?.click();
      await flush();
      expect(h.openLink).toHaveBeenCalledWith(withFromCard(card.url));
      expect(new URL(h.openLink.mock.calls[0]?.[0] as string).searchParams.get("from")).toBe(
        "card",
      );
      expect(h.answer).not.toHaveBeenCalled();
      // The button stays while the person is away — a blocked window is one press from another.
      expect(status(root)?.dataset.tone).toBe("waiting");
      expect(status(root)?.textContent).toBe(WAITING_SENTENCE);
      expect(root.querySelector("button")?.disabled).toBe(false);
      await until(() => status(root)?.dataset.tone === "answered");
      expect(h.status).toHaveBeenCalledWith(card.pendingActionId);
      expect(status(root)?.textContent).toBe(
        "Connected; the credential is stored and never shown again.",
      );
      expect(root.querySelectorAll("button")).toHaveLength(0);
      h.stop();
    });
  }

  it("settles on a decline's sentence, and on a refusal from the read", async () => {
    const declined = handlers({
      status: { ok: true, state: "declined", sentence: "Declined. The credential stands." },
    });
    const root = renderAsk(CREDENTIAL, declined, document);
    root.querySelector("button")?.click();
    await until(() => status(root)?.dataset.tone === "answered");
    expect(status(root)?.textContent).toBe("Declined. The credential stands.");
    declined.stop();

    const refused = handlers({
      status: { ok: false, reason: "expired", message: "This action has expired" },
    });
    const second = renderAsk(CREDENTIAL, refused, document);
    second.querySelector("button")?.click();
    await until(() => status(second)?.dataset.tone === "refused");
    expect(status(second)?.textContent).toBe("This action has expired");
    expect(second.querySelectorAll("button")).toHaveLength(0);
    refused.stop();
  });

  it("stops polling when the render is abandoned, and says so when the host refuses to open the page", async () => {
    const h = handlers({ status: { ok: true, state: "open", sentence: "Still waiting." } });
    const root = renderAsk(SECRET, h, document);
    root.querySelector("button")?.click();
    await until(() => h.status.mock.calls.length >= 2);
    h.stop();
    const calls = h.status.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.status.mock.calls.length).toBeLessThanOrEqual(calls + 1);

    const blocked = {
      ...handlers(),
      openLink: vi.fn(async () => Promise.reject(new Error("open-link not allowed"))),
    };
    const second = renderAsk(SECRET, blocked, document);
    second.querySelector("button")?.click();
    await flush();
    expect(status(second)?.dataset.tone).toBe("refused");
    expect(status(second)?.textContent).toContain("open-link not allowed");
    expect(blocked.status).not.toHaveBeenCalled();
    expect(second.querySelector("button")?.disabled).toBe(false);
  });
});

/**
 * A link provider's ask (GRA-117): the card mints the provider's sign-in through `start_link`
 * with the build choice, opens it, and polls until the link's return has answered the ask.
 */
describe("a connection a link provider covers", () => {
  /** GRA-128: the proposal's scheme is the keyring path the model read; this ask registers nothing. */
  it("names how the provider connects in the Scheme row, never the keyring label the proposal carries", () => {
    const scheme = factsOf(LINK).find((fact) => fact.label === "Scheme");
    expect(scheme?.value).toBe(
      "Sign-in at the vendor through broker; no client to register, nothing typed in Graft",
    );
    expect(scheme?.value).not.toContain("a client you register");
    // The same proposal on the keyring keeps the keyring label.
    const keyring: AskCard = { ...LINK, providerConnect: "form", provider: undefined };
    expect(factsOf(keyring).find((fact) => fact.label === "Scheme")?.value).toBe(
      "OAuth consent (a client you register)",
    );
    // A scope ask about a relay provider's row names the relay scheme in the person's words.
    expect(schemeLabel("relay")).toBe("Relayed through the provider (no credential in Graft)");
  });

  it("asks to connect through the provider, names it, offers a checked build choice, Decline and Connect through broker", () => {
    const root = renderAsk(LINK, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "connection", answerable: "false" });
    expect(root.querySelector("h1")?.textContent).toBe("Connect Gmail (gmail) through broker?");
    expect(root.textContent).toContain("sign in at the vendor on broker's page");
    expect(root.textContent).toContain("nothing is typed here");
    const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(root.textContent).toContain(buildChoiceLabel(LINK));
    expect(buttons(root)).toEqual(["Decline", "Connect through broker"]);
  });

  it("mints the link with the box as the person left it, opens it, and settles on the return's sentence", async () => {
    const h = handlers({
      status: [
        { ok: true, state: "open", sentence: "Still waiting." },
        {
          ok: true,
          state: "answered",
          sentence: "Connected through broker. Gmail (gmail) is in Claude's scope.",
        },
      ],
    });
    const root = renderAsk(LINK, h, document);
    const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;
    box.checked = false;
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "Connect through broker")
      ?.click();
    await flush();
    expect(h.startLink).toHaveBeenCalledWith({ pendingActionId: "pa_4", approveBuild: false });
    expect(h.openLink).toHaveBeenCalledWith(withFromCard("https://broker.fake/connect/ltok_1"));
    expect(h.answer).not.toHaveBeenCalled();
    expect(box.disabled).toBe(true);
    await until(() => status(root)?.dataset.tone === "answered");
    expect(status(root)?.textContent).toBe(
      "Connected through broker. Gmail (gmail) is in Claude's scope.",
    );
    expect(root.querySelectorAll("button")).toHaveLength(0);
    h.stop();
  });

  it("sends { decline: true } on Decline", async () => {
    const h = handlers({ answer: { ok: true, sentence: "Declined. Nothing was connected." } });
    const root = renderAsk(LINK, h, document);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Decline")?.click();
    await flush();
    expect(h.answer).toHaveBeenCalledWith({ decline: true });
    expect(h.startLink).not.toHaveBeenCalled();
    expect(status(root)?.textContent).toBe("Declined. Nothing was connected.");
  });

  it("falls back to the console button when the host refuses to open the link, and when start_link says card_not_available", async () => {
    const refusedOpen = {
      ...handlers(),
      openLink: vi.fn(async () => Promise.reject(new Error("no open-link"))),
    };
    const root = renderAsk(LINK, refusedOpen, document);
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "Connect through broker")
      ?.click();
    await flush();
    expect(buttons(root)).toEqual(["Decline", "Open in the console"]);
    expect(status(root)?.dataset.tone).toBe("refused");
    expect(status(root)?.textContent).toContain("The console has the same button");

    const notAvailable = handlers({
      startLink: {
        ok: false,
        reason: "card_not_available",
        message: "The ask card answers only for an agent connected from a chat product.",
      },
    });
    const second = renderAsk(LINK, notAvailable, document);
    [...second.querySelectorAll("button")]
      .find((b) => b.textContent === "Connect through broker")
      ?.click();
    await flush();
    expect(status(second)?.dataset.tone).toBe("refused");
    expect(buttons(second)).toEqual(["Open in the console"]);
    expect(second.querySelector("button")?.disabled).toBe(false);
  });

  it("shows a plain refusal from start_link with no way on but the link in the chat", async () => {
    const h = handlers({
      startLink: { ok: false, reason: "expired", message: "This action has expired" },
    });
    const root = renderAsk(LINK, h, document);
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "Connect through broker")
      ?.click();
    await flush();
    expect(status(root)?.textContent).toBe("This action has expired");
    expect(root.querySelectorAll("button")).toHaveLength(0);
    expect(h.openLink).not.toHaveBeenCalled();
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

  it("reads start_link's link and ask_status's state, each refusal, and calls anything else a failure", () => {
    expect(
      readStartLinkOutcome({ url: "https://p.fake/c/1", expiresAt: "2026-09-19T10:15:00.000Z" }),
    ).toEqual({
      ok: true,
      url: "https://p.fake/c/1",
      expiresAt: "2026-09-19T10:15:00.000Z",
      provider: "",
    });
    expect(
      readStartLinkOutcome({ error: "refused", reason: "card_not_available", message: "No." }),
    ).toEqual({ ok: false, reason: "card_not_available", message: "No." });
    expect(readStartLinkOutcome(undefined)).toMatchObject({ ok: false, reason: "failed" });

    expect(readAskStatusOutcome({ state: "answered", sentence: "Connected." })).toEqual({
      ok: true,
      state: "answered",
      sentence: "Connected.",
    });
    expect(readAskStatusOutcome({ state: "settled", sentence: "?" })).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(
      readAskStatusOutcome({ error: "refused", reason: "ask_not_found", message: "Not yours." }),
    ).toEqual({ ok: false, reason: "ask_not_found", message: "Not yours." });
  });

  it("adds from=card to a URL it opens, and leaves a string that is not a URL alone", () => {
    expect(withFromCard("http://console.graft.test/pending/pa_1?t=abc")).toBe(
      "http://console.graft.test/pending/pa_1?t=abc&from=card",
    );
    expect(withFromCard("not a url")).toBe("not a url");
  });
});

/**
 * The Setup offer (GRA-210): `find_tool`'s card for an agent whose person has no connection. No
 * ask stands behind it, so it draws one button that opens the Setup page with `from=card`, answers
 * nothing and polls nothing, and says to ask again once done.
 */
describe("the Setup offer", () => {
  const SETUP: SetupCard = {
    kind: "setup",
    agentName: "Claude",
    url: "http://console.graft.test/setup?agent=agent_claude",
  };

  it("draws the title, the sentence, the agent, the ask-again sentence and one button", () => {
    const root = renderCard(SETUP, handlers(), document);
    expect(root.dataset).toMatchObject({ kind: "setup", answerable: "false" });
    expect(root.querySelector(".ask-eyebrow")?.textContent).toBe(SETUP_EYEBROW);
    expect(root.querySelector("h1")?.textContent).toBe(SETUP_TITLE);
    expect(root.querySelector(".ask-description")?.textContent).toBe(setupDescriptionOf(SETUP));
    expect(root.textContent).toContain("Claude has no vendor connected yet.");
    expect(root.querySelector(".ask-note")?.textContent).toBe(setupAskAgainOf(SETUP));
    expect(setupAskAgainOf(SETUP)).toContain("Ask again here");
    expect(buttons(root)).toEqual([SETUP_BUTTON]);
    expect(SETUP_BUTTON).toBe("Set up your first tool");
    expect(root.querySelector("input")).toBeNull();
  });

  it("opens the Setup page with from=card, answers nothing and polls nothing", async () => {
    const h = handlers();
    const root = renderCard(SETUP, h, document);
    root.querySelector("button")?.click();
    await until(() => status(root)?.textContent === SETUP_OPENED_SENTENCE);
    expect(h.openLink).toHaveBeenCalledWith(
      "http://console.graft.test/setup?agent=agent_claude&from=card",
    );
    // Well past several poll intervals, and still nothing asked of Graft.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.answer).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    expect(h.startLink).not.toHaveBeenCalled();
    // The button stays, so a window closed early opens again.
    const again = root.querySelector("button");
    expect(again?.disabled).toBe(false);
    again?.click();
    await flush();
    expect(h.openLink).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("shows Setup's address to copy when the host refuses to open the window", async () => {
    const h = handlers();
    h.openLink.mockRejectedValueOnce(new Error("blocked"));
    const root = renderCard(SETUP, h, document);
    expect(root.querySelector(".ask-address")).toBeNull();
    root.querySelector("button")?.click();
    await until(() => status(root)?.dataset.tone === "refused");
    expect(status(root)?.textContent).toBe(
      `The chat could not open the window (blocked). Setup opens at this address in a browser, and ${SETUP.agentName} can give it to you too:`,
    );
    const address = root.querySelector<HTMLElement>(".ask-address");
    // The bare address: a browser tab has no card to tell, so it carries no from=card.
    expect(address?.textContent).toBe(SETUP.url);
    expect(address?.hidden).toBe(false);
    // A later click the host allows hides it again.
    root.querySelector("button")?.click();
    await until(() => status(root)?.dataset.tone === "waiting");
    expect(address?.hidden).toBe(true);
  });

  it("renders an ask through the same entry, unchanged", () => {
    const root = renderCard(BUILD, handlers(), document);
    expect(root.dataset.kind).toBe("build");
    expect(buttons(root)).toEqual(["Deny", "Allow"]);
  });

  it("is read off the wire as the Setup card, and never as an ask", () => {
    const result = {
      setup: { url: SETUP.url, message: "Relay it.", cardShown: true },
      card: SETUP,
    };
    expect(readCardData(result)).toEqual(SETUP);
    expect(readSetupCard(result)).toEqual(SETUP);
    expect(readAskCard(result)).toBeNull();
    expect(readCardData({ reason: "awaiting_approval", card: BUILD })).toEqual(BUILD);
    expect(readSetupCard({ card: { kind: "setup", agentName: "Claude" } })).toBeNull();
    expect(readCardData({ tools: [], connections: [] })).toBeNull();
  });
});
