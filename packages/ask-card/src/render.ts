import {
  type AnswerAskAnswer,
  type AnswerOutcome,
  ASK_STATUS_POLL_MS,
  type AskCard,
  type AskStatusOutcome,
  type StartLinkInput,
  type StartLinkOutcome,
  withFromCard,
} from "./shape";

/**
 * The card as DOM — a pure function of the ask's data and its handlers, so the render is tested
 * with a document and no host (`render.test.ts`), and `main.ts` is only the wiring to the host.
 *
 * Six shapes, in Cando's card anatomy (ADR 0017) and the console's voice. Four answer in place:
 * the **build approval** (Allow or Deny); the **tool's first-use approval** (GRA-116: the tool's
 * description in the model's words, its hints, Allow or Deny — the ask-every-call setting stays on
 * the console's page, and the card says when it is on); the **connection confirmation** for a
 * scheme that takes no credential (Connect or Decline, with GRA-75's build choice on by default);
 * and the **scope ask** — a connection the person already holds, asked for by an agent that was
 * not given it (GRA-104): Allow or Decline, with the same build choice. Two send the person
 * elsewhere and wait: a **link provider's ask** (GRA-117), where *Connect through <provider>*
 * asks Graft for the provider's sign-in link through `start_link` and opens it, and every ask
 * with a **secret** in it — a scheme with a credential, a credential re-entry — where *Enter the
 * secret in Graft* opens the handoff URL in the console (GRA-118). Secrets are entered in the
 * console and nowhere else (ADR 0004, ADR 0006); the card opens the page and never sees what is
 * typed on it.
 *
 * Once the person has been sent elsewhere the card polls `ask_status` every few seconds
 * (`ASK_STATUS_POLL_MS`) until the ask is settled — the console page, or the link's return, has
 * recorded the answer — and shows the sentence Graft answers in place of its buttons. It cannot
 * hear the page itself: the page posts to the window that opened it, and the card is a frame on
 * the host's origin. The poll stops when the ask settles or when `signal` aborts, which `main.ts`
 * does when the host renders another result into the same page.
 *
 * After a click the buttons are disabled, and the outcome the server answered — or its refusal —
 * replaces them as one sentence. A `card_not_available` refusal is the one that keeps a way
 * forward: the console button appears under it, since the handoff URL is the floor. The card
 * never writes into the chat: the person's click is the answer, and what the agent says next is
 * the agent's.
 */

export type CardHandlers = {
  /** The person's answer, to `answer_ask`; the outcome is what the card shows next. */
  answer: (answer: AnswerAskAnswer) => Promise<AnswerOutcome>;
  /** Open a URL in the person's browser — `ui/open-link`; rejects where the host refuses. */
  openLink: (url: string) => Promise<void>;
  /** Mint a link provider's sign-in link for this ask — `start_link` (GRA-117). */
  startLink: (input: StartLinkInput) => Promise<StartLinkOutcome>;
  /** Where the ask stands — `ask_status` (GRA-117, GRA-118). */
  status: (pendingActionId: string) => Promise<AskStatusOutcome>;
  /** Aborting it stops the poll; the host has moved on from this render. */
  signal?: AbortSignal;
  /** The poll's interval; `ASK_STATUS_POLL_MS` unless a test shortens it. */
  pollMs?: number;
};

/**
 * The scheme's label in the person's words — the console's `SCHEME_LABELS`
 * (`apps/web/src/lib/connection-form.ts`), copied because the card cannot import the console; a
 * scheme without an entry here shows its proxy name, so the copy going stale is visible, not wrong.
 */
const SCHEME_LABELS: Record<string, string> = {
  api_key_header: "API key in a header",
  api_key_query: "API key in a query parameter",
  bearer: "Bearer token",
  basic: "Username and password",
  oauth2_client_credentials: "OAuth2 client credentials",
  oauth_authorization_code: "OAuth consent (a client you register)",
  unleashed_hmac: "Unleashed HMAC (API id and key)",
  snowflake_keypair_jwt: "Snowflake key-pair JWT",
  none: "No credential (public API)",
  // The two relay schemes a row of a relay provider carries (ADR 0019): a scope ask about such a
  // row names them, and neither holds a credential in Graft.
  relay: "Relayed through the provider (no credential in Graft)",
  gateway: "Relayed through your API gateway (no credential in Graft)",
};

export function schemeLabel(scheme: string | null): string {
  return scheme === null ? "" : (SCHEME_LABELS[scheme] ?? scheme);
}

/**
 * The Scheme row of a link provider's ask (GRA-128). The proposal's `scheme` is the keyring path
 * the model read in the vendor's documentation — `oauth_authorization_code`, whose label says "a
 * client you register" — and this ask registers nothing: the person signs in at the vendor on the
 * provider's page and the provider holds the token. The row says that, and never the keyring label.
 */
export function linkSchemeLabel(card: AskCard): string {
  return `Sign-in at the vendor through ${card.provider ?? "the provider"}; no client to register, nothing typed in Graft`;
}

/** The person's own words for the pending-action kind — the eyebrow above the title. */
export function kindLabel(card: AskCard): string {
  switch (card.kind) {
    case "build":
      return "Build approval";
    case "connection":
      return "Connection";
    case "credential":
      return "Credential re-entry";
    case "tool":
      return "Approval";
    case "scope":
      return "Scope";
  }
}

/** Whether the card sends the person to a link provider's page rather than to the console. */
export function isLinkAsk(card: AskCard): boolean {
  return card.kind === "connection" && card.providerConnect === "link";
}

/**
 * Whether the ask has a secret typed into Graft, which the console alone may take (ADR 0004). A
 * link provider's ask has none whatever its scheme says: the token stays with the provider.
 */
export function takesSecret(card: AskCard): boolean {
  return (
    card.kind === "credential" ||
    (card.kind === "connection" && card.takesCredential && !isLinkAsk(card))
  );
}

/** The title question, as the console's cards phrase it. */
export function titleOf(card: AskCard): string {
  const what = `${card.displayName} (${card.vendor})`;
  switch (card.kind) {
    case "build":
      return `Let ${card.agentName} build tools against ${what}?`;
    case "connection":
      return isLinkAsk(card)
        ? `Connect ${what} through ${card.provider ?? "its provider"}?`
        : card.answerable
          ? `Connect ${what}?`
          : `Connect ${what} in the console`;
    case "credential":
      return `Re-enter the credential for ${what}`;
    case "tool":
      return `Allow ${card.agentName} to run ${card.toolName ?? "a tool"}?`;
    case "scope":
      return `Let ${card.agentName} use ${what}?`;
  }
}

/** The sentence under the title: what a yes means, or what happens in the window that opens. */
export function descriptionOf(card: AskCard): string {
  switch (card.kind) {
    case "build":
      return `${card.agentName} asked Graft to author tools against this connection. Reads only, every write previewed, until the first real use, which asks you once.`;
    case "connection":
      if (isLinkAsk(card)) {
        const provider = card.provider ?? "the provider";
        return `${card.agentName} proposes this connection. You sign in at the vendor on ${provider}'s page, which opens in a new window; the account's token stays with ${provider}, and nothing is typed here.`;
      }
      return card.answerable
        ? `${card.agentName} proposes this connection. The vendor takes no credential, so there is nothing to enter: confirming makes the connection and gives it to this agent.`
        : `${card.agentName} proposes this connection. Its credential is entered in Graft's console, which opens in a new window, never here or in the chat; this card updates once it is stored.`;
    case "credential":
      return `The vendor refused ${card.agentName}'s calls. The new credential is entered in Graft's console, which opens in a new window, never here or in the chat; this card updates once it is stored.`;
    case "tool": {
      const does = card.tool?.destructive
        ? "can delete or overwrite data at the vendor"
        : "changes data at the vendor";
      const holds = card.tool?.askEveryCall
        ? "You have set this tool to ask every time, so a yes is for this call alone; change that on the agent's page in the console."
        : "Your answer holds for this agent's next calls, a no as much as a yes, until withdrawn on its page in the console.";
      return `${card.agentName} wants to run a tool that ${does}. ${holds}`;
    }
    case "scope":
      return `You already have this connection${card.provider ? `, via ${card.provider}` : ""}; it was made for another of your agents. Allowing adds it to ${card.agentName}'s scope: no new connection, nothing entered, and its approvals stay as they are.`;
  }
}

/** A tool's hints in the person's words, as the console's `ToolAnnotations` chips read. */
export function toolHintsLabel(tool: NonNullable<AskCard["tool"]>): string {
  if (tool.readOnly) return "Read-only";
  return tool.destructive ? "Destructive: can delete or overwrite data" : "Changes data";
}

/** The list of facts under the description; each a label and a value, hosts and URLs in the mono stack. */
export function factsOf(card: AskCard): Array<{ label: string; value: string; mono?: boolean }> {
  const facts: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "Agent", value: card.agentName },
    { label: "Vendor", value: card.vendor },
    { label: "Connection", value: card.displayName },
  ];
  if (card.kind === "tool" && card.toolName) {
    facts.push({ label: "Tool", value: card.toolName, mono: true });
  }
  if (card.kind === "tool" && card.tool) {
    facts.push({ label: "What it does", value: toolHintsLabel(card.tool) });
  }
  if (card.primaryHost) facts.push({ label: "Primary host", value: card.primaryHost, mono: true });
  facts.push({ label: "Hosts", value: card.hosts.join(", "), mono: true });
  if (card.kind === "connection" || card.kind === "credential" || card.kind === "scope") {
    facts.push({
      label: "Scheme",
      value: isLinkAsk(card) ? linkSchemeLabel(card) : schemeLabel(card.scheme),
    });
  }
  if (card.provider && card.provider !== "keyring") {
    facts.push({ label: "Provider", value: card.provider });
  }
  if (card.docsUrl) facts.push({ label: "Documentation", value: card.docsUrl, mono: true });
  facts.push({ label: "Expires", value: expiresLabel(card.expiresAt) });
  return facts;
}

function expiresLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The label of the build choice on a keyless connection card, a link card and a scope card (GRA-75, GRA-104, GRA-117), on by default. */
export function buildChoiceLabel(card: AskCard): string {
  return `Also allow ${card.agentName} to build tools against this connection`;
}

/** The console button's label: a secret is typed there; anything else is answered there. */
export function consoleButtonLabel(card: AskCard): string {
  return takesSecret(card) ? "Enter the secret in Graft" : "Open in the console";
}

/** The note beside a tool's description, as the console's card marks it. */
export const MODEL_WORDS_NOTE = "written by the agent's model";

/** What the card says while the person is away, until `ask_status` says otherwise. */
export const WAITING_SENTENCE = "Waiting for you to finish in the window that opened.";

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  doc: Document,
  label: string,
  variant: "primary" | "secondary",
  onClick: () => void,
): HTMLButtonElement {
  const node = el(doc, "button", `ask-button ask-button-${variant}`, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Render one ask into a fresh element. The caller mounts it; `main.ts` mounts into `#ask`. The
 * element carries `data-kind` and `data-answerable` so a test — or a stylesheet — can read what
 * was drawn without reading the prose.
 */
export function renderAsk(card: AskCard, handlers: CardHandlers, doc: Document): HTMLElement {
  const root = el(doc, "section", "ask");
  root.dataset.kind = card.kind;
  root.dataset.answerable = String(card.answerable);
  root.setAttribute("aria-label", titleOf(card));

  const header = el(doc, "header");
  header.append(
    el(doc, "p", "ask-eyebrow", kindLabel(card)),
    el(doc, "h1", "ask-title", titleOf(card)),
    el(doc, "p", "ask-description", descriptionOf(card)),
  );
  root.append(header);

  const facts = el(doc, "dl", "ask-facts");
  for (const fact of factsOf(card)) {
    const row = el(doc, "div");
    row.append(
      el(doc, "dt", undefined, fact.label),
      el(doc, "dd", fact.mono ? "ask-mono" : undefined, fact.value),
    );
    facts.append(row);
  }
  root.append(facts);

  if (card.kind === "connection") {
    root.append(
      el(
        doc,
        "p",
        "ask-note",
        "This proposal was written by the agent's model from the documentation it read. Check the hosts before confirming.",
      ),
    );
  }

  // The tool's description, marked as the model's words as the console's card marks it (GRA-116):
  // a person deciding on a write should know the sentence was not written by anyone accountable.
  if (card.kind === "tool" && card.tool) {
    const quote = el(doc, "figure", "ask-quote");
    const caption = el(doc, "figcaption");
    caption.append(
      el(doc, "span", "ask-badge", MODEL_WORDS_NOTE),
      el(doc, "span", undefined, "Read it as the agent's account of what the tool does."),
    );
    quote.append(caption, el(doc, "blockquote", undefined, card.tool.description));
    root.append(quote);
  }

  const actions = el(doc, "div", "ask-actions");
  root.append(actions);

  /** The line under the buttons while the person is away, and the sentence once they are done. */
  const status = el(doc, "p", "ask-outcome");
  status.setAttribute("role", "status");
  status.hidden = true;

  const buttons: HTMLButtonElement[] = [];
  const disableAll = () => {
    for (const node of buttons) node.disabled = true;
  };

  /** Replace the actions with the outcome sentence; nothing is clickable afterwards. */
  const settle = (outcome: { ok: true; sentence: string } | { ok: false; message: string }) => {
    status.textContent = outcome.ok ? outcome.sentence : outcome.message;
    status.dataset.tone = outcome.ok ? "answered" : "refused";
    status.hidden = false;
    actions.replaceWith(status);
  };

  /** Show a sentence under the buttons without settling: the person can still act. */
  const note = (sentence: string, tone: "waiting" | "refused") => {
    status.textContent = sentence;
    status.dataset.tone = tone;
    status.hidden = false;
    if (!status.isConnected) actions.after(status);
  };

  /**
   * Poll `ask_status` until the ask is no longer open (GRA-118), then settle on Graft's sentence.
   * A refusal settles too — the read is gated as the answer is. One poll at a time: a second press
   * of the button while one runs opens the window again and leaves the poll be.
   */
  let polling = false;
  const pollUntilSettled = async () => {
    if (polling) return;
    polling = true;
    const every = handlers.pollMs ?? ASK_STATUS_POLL_MS;
    note(WAITING_SENTENCE, "waiting");
    while (!handlers.signal?.aborted) {
      await sleep(every, handlers.signal);
      if (handlers.signal?.aborted) break;
      let read: AskStatusOutcome;
      try {
        read = await handlers.status(card.pendingActionId);
      } catch {
        // The bridge hiccuped; the next tick reads again.
        continue;
      }
      if (!read.ok) {
        disableAll();
        settle({ ok: false, message: read.message });
        break;
      }
      if (read.state !== "open") {
        disableAll();
        settle({ ok: true, sentence: read.sentence });
        break;
      }
      note(read.sentence, "waiting");
    }
    polling = false;
  };

  /** Open a page in the person's browser with `from=card`, then wait for it to settle the ask. */
  const openAndWait = async (url: string) => {
    try {
      await handlers.openLink(withFromCard(url));
    } catch (error) {
      note(
        `The chat could not open the window (${error instanceof Error ? error.message : String(error)}). The link the agent relayed opens the same page.`,
        "refused",
      );
      return;
    }
    void pollUntilSettled();
  };

  /** The console button — the floor every ask keeps (ADR 0006) — appended to `into`. */
  const consoleButton = (into: HTMLElement) => {
    const open = button(doc, consoleButtonLabel(card), "primary", () => {
      void openAndWait(card.url);
    });
    buttons.push(open);
    into.append(open);
    return open;
  };

  const submit = async (answer: AnswerAskAnswer) => {
    disableAll();
    let outcome: AnswerOutcome;
    try {
      outcome = await handlers.answer(answer);
    } catch (error) {
      outcome = {
        ok: false,
        reason: "failed",
        message: `Graft could not record the answer (${error instanceof Error ? error.message : String(error)}). The link in the chat opens the same ask in the console.`,
      };
    }
    if (!outcome.ok && outcome.reason === "card_not_available") {
      // The console keeps this one: say so, and leave the way there under the sentence.
      settle(outcome);
      const fallback = el(doc, "div", "ask-actions");
      status.after(fallback);
      consoleButton(fallback).disabled = false;
      return;
    }
    settle(outcome.ok ? outcome : { ok: false, message: outcome.message });
  };

  if (isLinkAsk(card)) {
    // A link provider's ask (GRA-117): the build choice, Decline through `answer_ask`, and the
    // provider's sign-in minted through `start_link` and opened in the person's browser.
    const choice = el(doc, "label", "ask-choice");
    const box = el(doc, "input");
    box.type = "checkbox";
    box.checked = true;
    box.name = "approveBuild";
    choice.append(box, el(doc, "span", undefined, buildChoiceLabel(card)));
    actions.before(choice);

    const decline = button(doc, "Decline", "secondary", () => void submit({ decline: true }));
    const connect = button(
      doc,
      `Connect through ${card.provider ?? "the provider"}`,
      "primary",
      () => {
        void (async () => {
          box.disabled = true;
          decline.disabled = true;
          connect.disabled = true;
          let started: StartLinkOutcome;
          try {
            started = await handlers.startLink({
              pendingActionId: card.pendingActionId,
              approveBuild: box.checked,
            });
          } catch (error) {
            started = {
              ok: false,
              reason: "failed",
              message: `Graft could not start the sign-in (${error instanceof Error ? error.message : String(error)}). The link in the chat opens the same ask in the console.`,
            };
          }
          if (!started.ok) {
            settle({ ok: false, message: started.message });
            if (started.reason === "card_not_available") {
              const fallback = el(doc, "div", "ask-actions");
              status.after(fallback);
              consoleButton(fallback);
            }
            return;
          }
          try {
            await handlers.openLink(withFromCard(started.url));
          } catch {
            // The host refused to open it: the console's page has the same button (GRA-117).
            connect.replaceWith(consoleButton(actions));
            note(
              `The chat could not open ${card.provider ?? "the provider"}'s sign-in. The console has the same button.`,
              "refused",
            );
            return;
          }
          connect.disabled = false;
          void pollUntilSettled();
        })();
      },
    );
    buttons.push(decline, connect);
    actions.append(decline, connect);
    return root;
  }

  if (!card.answerable) {
    consoleButton(actions);
    return root;
  }

  if (card.kind === "build" || card.kind === "tool") {
    const deny = button(doc, "Deny", "secondary", () => void submit({ allow: false }));
    const allow = button(doc, "Allow", "primary", () => void submit({ allow: true }));
    buttons.push(deny, allow);
    actions.append(deny, allow);
    return root;
  }

  // A keyless connection, or a scope ask: the build choice above the two buttons, on by default
  // (GRA-75; GRA-104 for the scope ask, where Allow carries it as `approveBuild` beside `allow`).
  const choice = el(doc, "label", "ask-choice");
  const box = el(doc, "input");
  box.type = "checkbox";
  box.checked = true;
  box.name = "approveBuild";
  choice.append(box, el(doc, "span", undefined, buildChoiceLabel(card)));
  actions.before(choice);

  if (card.kind === "scope") {
    const decline = button(doc, "Decline", "secondary", () => void submit({ allow: false }));
    const allow = button(doc, "Allow", "primary", () => {
      box.disabled = true;
      void submit({ allow: true, approveBuild: box.checked });
    });
    buttons.push(decline, allow);
    actions.append(decline, allow);
    return root;
  }

  const decline = button(doc, "Decline", "secondary", () => void submit({ decline: true }));
  const connect = button(doc, "Connect", "primary", () => {
    box.disabled = true;
    void submit({ connect: true, approveBuild: box.checked });
  });
  buttons.push(decline, connect);
  actions.append(decline, connect);
  return root;
}
