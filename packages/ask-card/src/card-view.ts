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
  /** Draw the card for one tool result — or nothing, collapsing the frame — and report the size. */
  show(result: { structuredContent?: unknown }): void;
};

type ObserverConstructor = Parameters<typeof createFrameSizer>[3];

/**
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
    // A host that has gone away answers nothing; the next render reports again.
    host.sendSizeChanged(size).catch(() => {});
  };
  const sizer = createFrameSizer(doc, mount, send, Observer);
  let current: AbortController | null = null;

  return {
    show(result) {
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
