import { createFrameSizer, type SizeSink } from "./frame-size";
import { renderCard } from "./render";
import {
  ANSWER_ASK_TOOL,
  type AnswerAskInput,
  ASK_STATUS_TOOL,
  type AskStatusInput,
  readAnswerOutcome,
  readAskStatusOutcome,
  readCardData,
  readStartLinkOutcome,
  START_LINK_TOOL,
  type StartLinkInput,
} from "./shape";

/**
 * What the card needs of its host: the three calls a click makes and the size report. The
 * ext-apps `App` satisfies it as it is; a test hands in a fake (`card-view.test.ts`).
 */
export type CardHost = {
  callServerTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ structuredContent?: unknown }>;
  openLink(params: { url: string }): Promise<unknown>;
  sendSizeChanged(params: { height: number }): Promise<void>;
};

export type CardView = {
  /**
   * Before any result: keep the waiting line in the mount and report its height, every time it is
   * called (the first call precedes `connect()`, where the notification cannot be delivered yet).
   * Does nothing once a result has been shown.
   */
  waiting(): void;
  /**
   * The tool's input has arrived (`ui/notifications/tool-input`, before the result): the frame
   * stays at the waiting line, and nothing new is reported. Does nothing once a result is shown.
   */
  input(): void;
  /** Draw the card for one tool result — or nothing, collapsing the frame — and report the size. */
  show(result: { structuredContent?: unknown }): void;
};

/**
 * The one line the frame holds while the tool call is in flight (GRA-335). `ask.html` ships the
 * same element inside `#ask`, so the page has its height before the script runs;
 * `bundle.test.ts` holds the two to one spelling.
 */
export const WAITING_TEXT = "Waiting for Graft…";
export const WAITING_CLASS = "ask-waiting";

function waitingLine(doc: Document): HTMLElement {
  const line = doc.createElement("p");
  line.className = WAITING_CLASS;
  line.setAttribute("role", "status");
  line.textContent = WAITING_TEXT;
  return line;
}

type ObserverConstructor = Parameters<typeof createFrameSizer>[3];

/**
 * Before any result the mount holds one waiting line and the frame is sized to it (GRA-335): a
 * page that reported nothing was drawn at Claude's 150 px default, blank, for the whole of a call
 * that waits on an approval. A line rather than 0, because Claude's troubleshooting page treats a
 * zero-height frame as an invisible app, and a frame the card would have to grow out of nothing is
 * the one failure here that hides an ask the model was told not to relay as a link.
 *
 * One render per tool result into `mount` (GRA-84): the card off `structuredContent.card`, or
 * nothing when the result carries none, since a host mounts the same page for every result of a
 * tool that names it. Either way the height is reported once the DOM holds what the person will
 * see (`frame-size.ts`, GRA-275): the card's height, or 0 so the host draws no empty frame.
 *
 * A render is one `AbortController`: the host may deliver another result into this same page,
 * and the poll the earlier card started must stop with it.
 */
export function createCardView(
  host: CardHost,
  doc: Document,
  mount: HTMLElement,
  Observer?: ObserverConstructor,
): CardView {
  const send: SizeSink = (size) => {
    // A host that has gone away, or a bridge not yet connected (the first `waiting()`), answers
    // nothing; `<html>`'s height is already written, and the next report sends again.
    try {
      host.sendSizeChanged(size).catch(() => {});
    } catch {}
  };
  const sizer = createFrameSizer(doc, mount, send, Observer);
  let current: AbortController | null = null;
  let shown = false;

  const holdWaitingLine = (): void => {
    mount.hidden = false;
    if (
      mount.childElementCount === 1 &&
      mount.firstElementChild?.classList.contains(WAITING_CLASS)
    ) {
      return;
    }
    mount.replaceChildren(waitingLine(doc));
  };

  return {
    waiting() {
      if (shown) return;
      holdWaitingLine();
      sizer.report(true);
    },
    input() {
      if (shown) return;
      holdWaitingLine();
      sizer.report();
    },
    show(result) {
      shown = true;
      current?.abort();
      current = new AbortController();
      const card = readCardData(result.structuredContent);
      mount.replaceChildren();
      if (!card) {
        mount.hidden = true;
        sizer.report();
        return;
      }
      mount.hidden = false;
      mount.append(
        renderCard(
          card,
          {
            answer: async (answer) => {
              // The Setup offer (GRA-210) names no ask and draws no answer button; `renderCard`
              // never calls this for it, and `answer_ask` would refuse it.
              if (card.kind === "setup") throw new Error("the Setup card answers nothing");
              const input: AnswerAskInput = { pendingActionId: card.pendingActionId, answer };
              const answered = await host.callServerTool({
                name: ANSWER_ASK_TOOL,
                arguments: input,
              });
              return readAnswerOutcome(answered.structuredContent);
            },
            startLink: async (input: StartLinkInput) => {
              const started = await host.callServerTool({
                name: START_LINK_TOOL,
                arguments: input,
              });
              return readStartLinkOutcome(started.structuredContent);
            },
            status: async (pendingActionId) => {
              const input: AskStatusInput = { pendingActionId };
              const read = await host.callServerTool({ name: ASK_STATUS_TOOL, arguments: input });
              return readAskStatusOutcome(read.structuredContent);
            },
            openLink: async (url) => {
              await host.openLink({ url });
            },
            signal: current.signal,
          },
          doc,
        ),
      );
      sizer.report();
    },
  };
}
