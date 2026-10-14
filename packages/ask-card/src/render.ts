import {
  type AccessChoice,
  accessLegend,
  accessOptions,
  type ChoiceOption,
  DEFAULT_ACCESS_CHOICE,
  defaultToolAllowChoice,
  type ProposalFinish,
  proposalLead,
  proposalSummary,
  toolAllowAnswer,
  toolAllowOptions,
  toolLabel,
} from "./copy";
import {
  type AnswerAskAnswer,
  type AnswerOutcome,
  ASK_STATUS_POLL_MS,
  type AskCard,
  type AskStatusOutcome,
  type CardData,
  type SetupCard,
  type StartLinkInput,
  type StartLinkOutcome,
  withFromCard,
} from "./shape";

/**
 * The card as DOM — a pure function of the ask's data and its handlers, so the render is tested
 * with a document and no host (`render.test.ts`), and `main.ts` is only the wiring to the host.
 *
 * Six shapes, in Cando's card anatomy (ADR 0017), asking the handoff page's questions with its
 * choices (GRA-316; the words are `copy.ts`'s). Four answer in place: the **build approval** (Allow
 * or Decline); the **tool's first-use approval** (GRA-116: Allow or Deny, and where the server
 * offers the integration-wide yes, GRA-237, how much it allows, ADR 0008 as amended 2026-10-14:
 * *Every <integration> tool* pre-selected and never destructive, *Just <tool>* pre-selected on a
 * tool that can delete, no allow for one call; the ask-every-call setting stays on the console's
 * page, and the card says when it is on); the **connection confirmation** for a scheme that takes
 * no credential (Connect or Decline); and the **scope ask**, a connection the person already
 * holds, asked for by an agent that was not given it (GRA-104): Allow or Decline. Both carry
 * *Full access / Ask me first* in place of the build choice and the integration's line. Two send
 * the person elsewhere and wait: a **link provider's ask** (GRA-117), where *Sign in with
 * <integration>* asks Graft for the provider's sign-in link through `start_link` and opens it,
 * under the same access choice, and every ask with a **secret** in it (a scheme with a credential,
 * a credential re-entry), where *Open in Graft* opens the handoff URL in the console (GRA-118).
 * Secrets are entered in the console and nowhere else (ADR 0004, ADR 0006); the card opens the page
 * and never sees what is typed on it.
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
 *
 * A seventh shape is no ask (GRA-210): **Setup**, `find_tool`'s offer for an agent whose person
 * has no connection yet (`renderSetup`). One button, *Set up your first tool*, opens the console's
 * Setup page with `from=card`; the page closes itself when the person finishes, and the card polls
 * nothing, since no pending action stands behind it. Its sentence says to ask again once done.
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
  return `Sign-in to ${card.displayName} through ${card.provider ?? "the provider"}; no client to register, nothing typed in Graft`;
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

/** The integration's name as the person reads it: the server's, else the slug (an older card). */
export function integrationOf(card: AskCard): string {
  return card.integrationName ?? card.vendor;
}

/** Whether the scheme signs in by OAuth consent, which the console's cards word as a sign-in. */
function isConsent(card: AskCard): boolean {
  return card.scheme === "oauth_authorization_code";
}

/** The tool's name as a person reads it ("Create order"), as the handoff page's question has it. */
function toolWords(card: AskCard): string {
  return card.toolName ? toolLabel(card.toolName, card.vendor) : "a tool";
}

/**
 * The title, the handoff page's question for the kind (GRA-314, GRA-316): the console's focused
 * cards (`apps/web/src/components/pending/*-ask-card.tsx`) spell each inline, so these are copied
 * by hand, and `render.test.ts` holds them.
 */
export function titleOf(card: AskCard): string {
  const integration = integrationOf(card);
  switch (card.kind) {
    case "build":
      return `Allow ${card.agentName} to build its own ${integration} tools?`;
    case "connection":
      return card.widens
        ? `Let ${card.displayName} reach more for ${card.agentName}?`
        : `Connect ${card.displayName} for ${card.agentName}?`;
    case "credential":
      return isConsent(card)
        ? `Reconnect ${card.displayName} for ${card.agentName}?`
        : `Enter a new key for ${card.displayName}?`;
    case "tool":
      return `Allow ${card.agentName} to run ${toolWords(card)} in ${integration}?`;
    case "scope":
      return `Let ${card.agentName} use your ${card.displayName} connection?`;
  }
}

/** How a connection ask finishes, in `proposalLead`'s terms. */
function finishOf(card: AskCard): ProposalFinish {
  if (card.widens) return "widen";
  if (isLinkAsk(card)) return "link";
  if (isConsent(card)) return "consent";
  return card.takesCredential ? "key" : "keyless";
}

/** The line under the title: where the ask came from, and what is left to do. */
export function descriptionOf(card: AskCard): string {
  const integration = integrationOf(card);
  switch (card.kind) {
    case "build":
      return `Graft's model reads from ${card.displayName} while it writes a tool: reads only, with every write previewed and never sent.`;
    case "connection":
      return proposalLead({
        agentName: card.agentName,
        integrationName: integration,
        docsUrl: card.docsUrl,
        finish: finishOf(card),
        ...(card.provider ? { provider: card.provider } : {}),
        ...(card.widens ? { addedHosts: card.widens.addedHosts } : {}),
      });
    case "credential":
      return `${integration} refused the key ${card.agentName} was using. ${isConsent(card) ? "Sign in again" : "Enter a new one"} to carry on.`;
    case "tool":
      return `Through your ${card.displayName} connection, at ${card.hosts.join(", ")}.`;
    case "scope":
      return "You connected it for another of your agents. Nothing new is made and nothing is entered.";
  }
}

/** The tool's mark and sentence: the server's (`@graft/core`'s `toolProvenance`), else an authored tool's. */
function provenanceOf(tool: NonNullable<AskCard["tool"]>): { badge: string; note: string } {
  return tool.provenance ?? { badge: MODEL_WORDS_NOTE, note: AUTHORED_PROVENANCE_NOTE };
}

/**
 * The muted line above *Details*, as the handoff page draws it: for a tool, the provenance line
 * (where the tool came from, and where it sends data); for a connection, where it goes, how it
 * signs in and where the proposal came from.
 */
export function summaryOf(card: AskCard): string {
  const hosts = card.hosts.join(", ");
  switch (card.kind) {
    case "build":
      return hosts;
    case "connection":
      if (card.widens) return hosts;
      return proposalSummary({
        primaryHost: card.primaryHost ?? card.hosts[0] ?? "",
        scheme: card.scheme ?? "",
        integrationName: integrationOf(card),
        docsUrl: card.docsUrl,
        ...(isLinkAsk(card) ? { provider: card.provider ?? "the provider" } : {}),
        schemeLabel,
      });
    case "credential":
      return `${hosts} · approvals stay as they are`;
    case "tool":
      return card.tool ? `${provenanceOf(card.tool).badge} · sends data to ${hosts}` : hosts;
    case "scope":
      return card.provider ? `${hosts} · through ${card.provider}` : hosts;
  }
}

/** A tool's hints in the person's words, as the console's `ToolAnnotations` chips read. */
export function toolHintsLabel(tool: NonNullable<AskCard["tool"]>): string {
  if (tool.readOnly) return "Read-only";
  return tool.destructive ? "Destructive: can delete or overwrite data" : "Changes data";
}

/** The facts behind *Details*; each a label and a value, hosts and URLs in the mono stack. */
export function factsOf(card: AskCard): Array<{ label: string; value: string; mono?: boolean }> {
  const facts: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "Agent", value: card.agentName },
    { label: "Integration", value: integrationOf(card) },
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
  if (card.kind === "connection" && card.widens) {
    facts.push({ label: "Adds", value: card.widens.addedHosts.join(", "), mono: true });
  }
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

/**
 * The console button's label: *Open in Graft* where a secret is typed there (Flow A, frame
 * 2103:10848), *Open in the console* where the ask is answered there for another reason.
 */
export function consoleButtonLabel(card: AskCard): string {
  return takesSecret(card) ? "Open in Graft" : "Open in the console";
}

/** The yes button's label, as the handoff page's for the kind. */
export function approveLabelOf(card: AskCard): string {
  if (isLinkAsk(card)) return `Sign in with ${card.displayName}`;
  return card.kind === "connection" ? "Connect" : "Allow";
}

/** The no button's label: *Deny* on a tool, as the handoff page words it; *Decline* elsewhere. */
export function declineLabelOf(card: AskCard): string {
  return card.kind === "tool" ? "Deny" : "Decline";
}

/**
 * The access choice's options for this card: the handoff page's, except that a card the server
 * wrote without the integration's line (`vendorTools`) cannot send that allow, so its *Full access*
 * promises the build approval alone (Greptile on #266).
 */
export function accessOptionsFor(card: AskCard): ChoiceOption<AccessChoice>[] {
  const options = accessOptions(card.agentName, integrationOf(card));
  if (card.vendorTools) return options;
  return options.map((option) =>
    option.value === "full"
      ? {
          ...option,
          description: `${card.agentName} can build ${integrationOf(card)} tools without asking. A tool that changes data still asks the first time it runs.`,
        }
      : option,
  );
}

/** The legend over a tool ask's choices, as the handoff page's. */
export function toolAllowLegend(agentName: string): string {
  return `How much should ${agentName} get?`;
}

/** The line a tool set to ask every call carries: the setting is the console's (ADR 0006). */
export function askEveryCallNote(card: AskCard): string {
  return `You set ${toolWords(card)} to ask every time it runs, so ${card.agentName} asks again next call. Change that on the agent's page in Graft.`;
}

/**
 * The mark and sentence beside an authored tool's description, for a card whose data carries no
 * `provenance` (a server older than GRA-245). The server's are `@graft/core`'s `toolProvenance`.
 */
export const MODEL_WORDS_NOTE = "written by the agent's model";
const AUTHORED_PROVENANCE_NOTE =
  "This tool's description was written by the agent's model, not by a person. Read it as the agent's account of what the tool does.";

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

/**
 * One choice among a few, the console's `ChoiceCards` in plain DOM: a fieldset with its legend,
 * one label per option holding the radio, the title (with *Recommended* where the option is) and
 * the description; the label's checked state draws the selected frame. Answers the value checked.
 */
function choiceCards<V extends string>(
  doc: Document,
  name: string,
  legend: string,
  options: readonly ChoiceOption<V>[],
  initial: V,
): { node: HTMLFieldSetElement; value: () => V; inputs: HTMLInputElement[] } {
  const node = el(doc, "fieldset", "ask-choices");
  node.append(el(doc, "legend", undefined, legend));
  const inputs: HTMLInputElement[] = [];
  for (const option of options) {
    const label = el(doc, "label", "ask-option");
    const input = el(doc, "input");
    input.type = "radio";
    input.name = name;
    input.value = option.value;
    input.checked = option.value === initial;
    inputs.push(input);
    const words = el(doc, "span", "ask-option-words");
    const title = el(doc, "span", "ask-option-title", option.title);
    if (option.recommended) title.append(el(doc, "span", "ask-badge", "Recommended"));
    words.append(title, el(doc, "span", "ask-option-hint", option.description));
    label.append(input, words);
    node.append(label);
  }
  const value = () => (inputs.find((input) => input.checked)?.value ?? initial) as V;
  return { node, value, inputs };
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
 *
 * The handoff page's anatomy (GRA-314, GRA-316): the question and its line, the choices, the two
 * answers side by side, then the summary line with the facts behind a native *Details*
 * disclosure, which the frame's `ResizeObserver` follows as it opens and closes.
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

  const actions = el(doc, "div", "ask-actions");
  root.append(actions);

  // The summary and the facts behind *Details*, under the answers as on the handoff page. A tool's
  // description, marked with where the tool came from (GRA-116, GRA-245), and a proposal's
  // provenance sentence (GRA-28) sit inside it with the facts.
  const footer = el(doc, "footer", "ask-footer");
  footer.append(el(doc, "p", "ask-summary", summaryOf(card)));
  const details = el(doc, "details", "ask-details");
  details.append(el(doc, "summary", undefined, "Details"));
  if (card.kind === "tool" && card.tool) {
    const provenance = provenanceOf(card.tool);
    const quote = el(doc, "figure", "ask-quote");
    const caption = el(doc, "figcaption");
    caption.append(
      el(doc, "span", "ask-badge", provenance.badge),
      el(doc, "span", undefined, provenance.note),
    );
    quote.append(caption, el(doc, "blockquote", undefined, card.tool.description));
    details.append(quote);
  }
  if (card.kind === "connection") {
    details.append(
      el(
        doc,
        "p",
        "ask-note",
        "The agent proposed this connection, from documentation it read or from a ready-made tool's details. Check the hosts before confirming.",
      ),
    );
  }
  const facts = el(doc, "dl", "ask-facts");
  for (const fact of factsOf(card)) {
    const row = el(doc, "div");
    row.append(
      el(doc, "dt", undefined, fact.label),
      el(doc, "dd", fact.mono ? "ask-mono" : undefined, fact.value),
    );
    facts.append(row);
  }
  details.append(facts);
  footer.append(details);
  root.append(footer);

  /** The line under the buttons while the person is away, and the sentence once they are done. */
  const status = el(doc, "p", "ask-outcome");
  status.setAttribute("role", "status");
  status.hidden = true;

  const buttons: HTMLButtonElement[] = [];
  /** The choices' radios, frozen with the buttons once an answer or a start is under way. */
  const controls: HTMLInputElement[] = [];
  const disableAll = () => {
    for (const node of buttons) node.disabled = true;
    for (const node of controls) node.disabled = true;
  };

  /** Replace the actions with the outcome sentence; nothing is clickable afterwards. */
  const settle = (outcome: { ok: true; sentence: string } | { ok: false; message: string }) => {
    status.textContent = outcome.ok ? outcome.sentence : outcome.message;
    status.dataset.tone = outcome.ok ? "answered" : "refused";
    status.hidden = false;
    for (const node of controls) node.disabled = true;
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

  /** Mount a choice above the answers and freeze it with them. */
  const mountChoices = <V extends string>(choices: ReturnType<typeof choiceCards<V>>) => {
    controls.push(...choices.inputs);
    actions.before(choices.node);
    return choices.value;
  };

  /**
   * *Full access / Ask me first* (ADR 0008 as amended 2026-10-14), in place of the two pre-ticked
   * lines: Full access is the build approval and, where the server offers the integration's line
   * (`vendorTools`, GRA-239), the standing allow for its non-destructive tools; Ask me first
   * records neither. A card the server wrote without the line never sends `allowVendor`.
   */
  const accessChoice = () => {
    const value = mountChoices(
      choiceCards(
        doc,
        `${card.pendingActionId}-access`,
        accessLegend(card.agentName),
        accessOptionsFor(card),
        DEFAULT_ACCESS_CHOICE,
      ),
    );
    return (): { approveBuild: boolean; allowVendor?: boolean } => {
      const full = value() === "full";
      return { approveBuild: full, ...(card.vendorTools ? { allowVendor: full } : {}) };
    };
  };

  const decline = (answer: AnswerAskAnswer) => {
    const node = button(doc, declineLabelOf(card), "secondary", () => void submit(answer));
    buttons.push(node);
    return node;
  };

  if (isLinkAsk(card)) {
    // A link provider's ask (GRA-117): the access choice, Decline through `answer_ask`, and the
    // provider's sign-in minted through `start_link` and opened in the person's browser.
    const access = accessChoice();
    const no = decline({ decline: true });
    const connect = button(doc, approveLabelOf(card), "primary", () => {
      void (async () => {
        disableAll();
        let started: StartLinkOutcome;
        try {
          started = await handlers.startLink({
            pendingActionId: card.pendingActionId,
            ...access(),
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
    });
    buttons.push(connect);
    actions.append(no, connect);
    return root;
  }

  if (!card.answerable) {
    consoleButton(actions);
    return root;
  }

  if (card.kind === "tool") {
    if (card.tool?.askEveryCall) {
      header.append(el(doc, "p", "ask-note", askEveryCallNote(card)));
    }
    // How much the yes allows (ADR 0008 as amended 2026-10-14): *Every <integration> tool*
    // pre-selected on a tool that cannot delete, *Just <tool>* on one that can; no allow for one
    // call. Offered where the server offers the integration-wide yes (GRA-237); a card written
    // without it answers this tool alone, as it always did.
    const offer = card.vendorApproval;
    const choice = offer
      ? mountChoices(
          choiceCards(
            doc,
            `${card.pendingActionId}-allow`,
            toolAllowLegend(card.agentName),
            toolAllowOptions({
              agentName: card.agentName,
              integrationName: offer.integrationName,
              tool: toolWords(card),
              destructive: card.tool?.destructive === true,
            }),
            defaultToolAllowChoice(card.tool?.destructive === true),
          ),
        )
      : null;
    const no = decline({ allow: false });
    const allow = button(doc, approveLabelOf(card), "primary", () => {
      void submit(choice ? toolAllowAnswer(choice()) : { allow: true });
    });
    buttons.push(allow);
    actions.append(no, allow);
    return root;
  }

  if (card.kind === "build") {
    const no = decline({ allow: false });
    const allow = button(doc, approveLabelOf(card), "primary", () => void submit({ allow: true }));
    buttons.push(allow);
    actions.append(no, allow);
    return root;
  }

  // A keyless connection, or a scope ask: the access choice above the two buttons (GRA-75, GRA-104,
  // GRA-239; on the scope ask Allow carries it beside `allow`).
  const access = accessChoice();
  if (card.kind === "scope") {
    const no = decline({ allow: false });
    const allow = button(doc, approveLabelOf(card), "primary", () => {
      const { approveBuild, allowVendor } = access();
      void submit(
        allowVendor === undefined
          ? { allow: true, approveBuild }
          : { allow: true, approveBuild, allowVendor },
      );
    });
    buttons.push(allow);
    actions.append(no, allow);
    return root;
  }

  const no = decline({ decline: true });
  const connect = button(doc, approveLabelOf(card), "primary", () => {
    void submit({ connect: true, ...access() });
  });
  buttons.push(connect);
  actions.append(no, connect);
  return root;
}

/** The Setup card's words (GRA-210): the eyebrow, the title, and the button, which says the same. */
export const SETUP_EYEBROW = "Setup";
export const SETUP_TITLE = "Set up your first tool";
export const SETUP_BUTTON = "Set up your first tool";

/** What the Setup card says under its title: what Setup does, and where it happens. */
export function setupDescriptionOf(card: SetupCard): string {
  return `${card.agentName} has no integration connected yet. Setup, in Graft's console, connects one and has Graft acquire a first tool for this agent in a few clicks. It opens in a new window, and nothing is typed in the chat.`;
}

/** The sentence the Setup card always carries: there is nothing to wait for here, so ask again. */
export function setupAskAgainOf(card: SetupCard): string {
  return `Once Setup is done, its window closes itself. Ask again here, and ${card.agentName} finds the new tool.`;
}

/** What the Setup card says once the window is open. */
export const SETUP_OPENED_SENTENCE =
  "Setup is open in the window that opened. Ask again here once you have finished.";

/**
 * What the Setup card says when the host refuses to open the window, above Setup's address drawn
 * on the card to copy. The agent was told not to send a link while the card is shown, so the card
 * carries the address itself, and the agent gives the same one when asked
 * (`@graft/mcp`'s `setupOfferMessage`).
 */
export function setupOpenRefusedOf(card: SetupCard, reason: string): string {
  return `The chat could not open the window (${reason}). Setup opens at this address in a browser, and ${card.agentName} can give it to you too:`;
}

/**
 * Render the Setup offer (GRA-210) into a fresh element: the title, the sentence, the agent, the
 * ask-again sentence and one primary button that opens the Setup page with `from=card` through the
 * host's link opener. Nothing is answered and nothing is polled; the button is disabled only while
 * the host's opener is answering, so one attempt settles before the next starts and an older
 * refusal cannot overwrite a later success, and enabled again after, so a window the person closed
 * early can be opened again. Where the host refuses to open it, the card shows Setup's address to
 * copy (`setupOpenRefusedOf`).
 */
export function renderSetup(
  card: SetupCard,
  handlers: Pick<CardHandlers, "openLink">,
  doc: Document,
): HTMLElement {
  const root = el(doc, "section", "ask");
  root.dataset.kind = card.kind;
  root.dataset.answerable = "false";
  root.setAttribute("aria-label", SETUP_TITLE);

  const header = el(doc, "header");
  header.append(
    el(doc, "p", "ask-eyebrow", SETUP_EYEBROW),
    el(doc, "h1", "ask-title", SETUP_TITLE),
    el(doc, "p", "ask-description", setupDescriptionOf(card)),
  );
  root.append(header);

  const facts = el(doc, "dl", "ask-facts");
  const row = el(doc, "div");
  row.append(el(doc, "dt", undefined, "Agent"), el(doc, "dd", undefined, card.agentName));
  facts.append(row);
  root.append(facts, el(doc, "p", "ask-note", setupAskAgainOf(card)));

  const actions = el(doc, "div", "ask-actions");
  const status = el(doc, "p", "ask-outcome");
  status.setAttribute("role", "status");
  status.hidden = true;
  const note = (sentence: string, tone: "waiting" | "refused") => {
    status.textContent = sentence;
    status.dataset.tone = tone;
    status.hidden = false;
    if (!status.isConnected) actions.after(status);
  };
  // The address a browser opens Setup at, shown only when the host refused the window: without
  // `from=card`, since that page has no card to tell and should not close itself.
  const address = el(doc, "p", "ask-mono ask-address", card.url);
  address.hidden = true;

  const open = button(doc, SETUP_BUTTON, "primary", () => {
    if (open.disabled) return;
    open.disabled = true;
    void (async () => {
      try {
        await handlers.openLink(withFromCard(card.url));
      } catch (error) {
        note(
          setupOpenRefusedOf(card, error instanceof Error ? error.message : String(error)),
          "refused",
        );
        address.hidden = false;
        if (!address.isConnected) status.after(address);
        return;
      } finally {
        open.disabled = false;
      }
      address.hidden = true;
      note(SETUP_OPENED_SENTENCE, "waiting");
    })();
  });
  actions.append(open);
  root.append(actions);
  return root;
}

/** Render whatever the result carried: the Setup offer, or an ask (`main.ts`'s one call). */
export function renderCard(card: CardData, handlers: CardHandlers, doc: Document): HTMLElement {
  return card.kind === "setup" ? renderSetup(card, handlers, doc) : renderAsk(card, handlers, doc);
}
