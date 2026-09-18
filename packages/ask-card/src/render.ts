import type { AnswerAskAnswer, AnswerOutcome, AskCard } from "./shape";

/**
 * The card as DOM — a pure function of the ask's data and two handlers, so the render is tested
 * with a document and no host (`render.test.ts`), and `main.ts` is only the wiring to the host.
 *
 * Three shapes, in Cando's card anatomy (ADR 0017) and the console's voice: the **build approval**
 * (Allow or Deny), the **connection confirmation** for a scheme that takes no credential (Connect
 * or Decline, with GRA-75's build choice on by default), and, for every ask the card may not
 * answer — a scheme with a secret, a credential re-entry, a link provider's ask, a tool's first use
 * — the proposal as text and one button, *Open in the console*, which opens the handoff URL.
 * Secrets are entered in the console and nowhere else (ADR 0004, ADR 0006).
 *
 * After a click the buttons are disabled, and the outcome the server answered — or its refusal
 * — replaces them as one sentence. The card never writes into the chat: the person's click is the
 * answer, and what the agent says next is the agent's.
 */

export type CardHandlers = {
  /** The person's answer, to `answer_ask`; the outcome is what the card shows next. */
  answer: (answer: AnswerAskAnswer) => Promise<AnswerOutcome>;
  /** Open the handoff URL in the person's browser — `ui/open-link`. */
  openConsole: (url: string) => Promise<void>;
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
};

export function schemeLabel(scheme: string | null): string {
  return scheme === null ? "" : (SCHEME_LABELS[scheme] ?? scheme);
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
  }
}

/** The title question, as the console's cards phrase it. */
export function titleOf(card: AskCard): string {
  const what = `${card.displayName} (${card.vendor})`;
  switch (card.kind) {
    case "build":
      return `Let ${card.agentName} build tools against ${what}?`;
    case "connection":
      return card.providerConnect === "link"
        ? `Connect ${what} through ${card.provider ?? "its provider"}`
        : card.answerable
          ? `Connect ${what}?`
          : `Connect ${what} in the console`;
    case "credential":
      return `Re-enter the credential for ${what}`;
    case "tool":
      return `Approve ${card.toolName ?? "a tool"} against ${what}`;
  }
}

/** The sentence under the title: what a yes means, or why the console is the place. */
export function descriptionOf(card: AskCard): string {
  switch (card.kind) {
    case "build":
      return `${card.agentName} asked Graft to author tools against this connection. Reads only, every write previewed, until the first real use, which asks you once.`;
    case "connection":
      if (card.providerConnect === "link") {
        return `${card.agentName} proposes this connection. You sign in at the vendor on ${card.provider ?? "the provider"}'s page, in the console; the vendor's token stays there.`;
      }
      return card.answerable
        ? `${card.agentName} proposes this connection. The vendor takes no credential, so there is nothing to enter: confirming makes the connection and gives it to this agent.`
        : `${card.agentName} proposes this connection. Its credential is entered in the console, never here or in the chat.`;
    case "credential":
      return `The vendor refused ${card.agentName}'s calls. The new credential is entered in the console, never here or in the chat.`;
    case "tool":
      return `${card.agentName} wants to run a tool that changes data. The console shows the tool's description and lets you set it to ask every time.`;
  }
}

/** The list of facts under the description; each a label and a value, hosts and URLs in the mono stack. */
export function factsOf(card: AskCard): Array<{ label: string; value: string; mono?: boolean }> {
  const facts: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "Agent", value: card.agentName },
    { label: "Vendor", value: card.vendor },
    { label: "Connection", value: card.displayName },
  ];
  if (card.primaryHost) facts.push({ label: "Primary host", value: card.primaryHost, mono: true });
  facts.push({ label: "Hosts", value: card.hosts.join(", "), mono: true });
  if (card.kind === "connection" || card.kind === "credential") {
    facts.push({ label: "Scheme", value: schemeLabel(card.scheme) });
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

/** The label of the build choice on a keyless connection card (GRA-75), on by default. */
export function buildChoiceLabel(card: AskCard): string {
  return `Also allow ${card.agentName} to build tools against this connection`;
}

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

  const actions = el(doc, "div", "ask-actions");
  root.append(actions);

  /** Replace the actions with the outcome sentence; nothing is clickable afterwards. */
  const settle = (outcome: AnswerOutcome) => {
    const sentence = el(doc, "p", "ask-outcome", outcome.ok ? outcome.sentence : outcome.message);
    sentence.setAttribute("role", "status");
    sentence.dataset.tone = outcome.ok ? "answered" : "refused";
    actions.replaceWith(sentence);
  };

  const buttons: HTMLButtonElement[] = [];
  const disableAll = () => {
    for (const node of buttons) node.disabled = true;
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
    settle(outcome);
  };

  if (!card.answerable) {
    const open = button(doc, "Open in the console", "primary", () => {
      void handlers.openConsole(card.url);
    });
    buttons.push(open);
    actions.append(open);
    return root;
  }

  if (card.kind === "build") {
    const deny = button(doc, "Deny", "secondary", () => void submit({ allow: false }));
    const allow = button(doc, "Allow", "primary", () => void submit({ allow: true }));
    buttons.push(deny, allow);
    actions.append(deny, allow);
    return root;
  }

  // A keyless connection: the build choice above the two buttons, on by default (GRA-75).
  const choice = el(doc, "label", "ask-choice");
  const box = el(doc, "input");
  box.type = "checkbox";
  box.checked = true;
  box.name = "approveBuild";
  choice.append(box, el(doc, "span", undefined, buildChoiceLabel(card)));
  actions.before(choice);

  const decline = button(doc, "Decline", "secondary", () => void submit({ decline: true }));
  const connect = button(doc, "Connect", "primary", () => {
    box.disabled = true;
    void submit({ connect: true, approveBuild: box.checked });
  });
  buttons.push(decline, connect);
  actions.append(decline, connect);
  return root;
}
