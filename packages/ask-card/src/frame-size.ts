/**
 * The card's frame height, reported by the card itself (GRA-275). A host mounts `ui://graft/ask`
 * for every result of a tool that names it, an ask or not (GRA-116, GRA-210), and mounts it while
 * the call is still in flight, so the card has to say "I am this tall", "I am nothing" and, before
 * any result, "I am one line".
 *
 * Two hosts, two readings, so every report is written twice:
 * - `ui/notifications/size-changed`, the spec's (MCP Apps 2026-01-26), which ChatGPT and the
 *   ext-apps reference host apply. Claude's troubleshooting page says a height of 0 there gives a
 *   zero-height frame, which is the collapse a result with no card wants.
 * - `<html>`'s inline height, because Claude.ai reads the frame document's height off the DOM
 *   rather than acting on the notification (anthropics/claude-ai-mcp#69).
 *
 * Why not ext-apps' `autoResize`: it starts measuring at `connect()`, whatever the page holds, and
 * that issue reports Claude locking the frame at a measurement taken before the content rendered.
 * So the card decides what is measured: before the first result the mount holds one waiting line
 * (`card-view.ts`, GRA-335) and that line's height is reported, since a page that reported nothing
 * was drawn at Claude's 150 px default for the whole of a call that waits on an approval; a result
 * is measured synchronously after its render (layout is forced by the measurement); and a
 * `ResizeObserver` on the mount reports every change after that: fonts landing, a sentence
 * replacing the buttons, the host's width changing.
 *
 * The height is the mount's, not the document's: the document's would be circular once `<html>`
 * carries an explicit height.
 */

export type SizeSink = (size: { height: number }) => void;

type ObserverConstructor = new (
  callback: () => void,
) => {
  observe(target: Element): void;
  disconnect(): void;
};

export type FrameSizer = {
  /**
   * Measure the mount now and report its height if it changed, or regardless under `force`, for a
   * notification an earlier report could not deliver; starts observing on the first call.
   */
  report(force?: boolean): void;
  /** Stop observing. */
  dispose(): void;
};

/** The mount's content height in whole pixels: 0 when it is hidden or holds nothing. */
export function contentHeightOf(mount: HTMLElement): number {
  if (mount.hidden || mount.childElementCount === 0) return 0;
  return Math.ceil(Math.max(mount.getBoundingClientRect().height, mount.scrollHeight));
}

export function createFrameSizer(
  doc: Document,
  mount: HTMLElement,
  send: SizeSink,
  Observer: ObserverConstructor | undefined = globalThis.ResizeObserver,
): FrameSizer {
  let last: number | null = null;
  let observer: InstanceType<ObserverConstructor> | null = null;

  const report = (force = false): void => {
    const height = contentHeightOf(mount);
    if (height === last && !force) return;
    last = height;
    doc.documentElement.style.height = `${height}px`;
    send({ height });
  };

  return {
    report(force = false) {
      if (!observer && Observer) {
        observer = new Observer(() => report());
        observer.observe(mount);
      }
      report(force);
    },
    dispose() {
      observer?.disconnect();
      observer = null;
    },
  };
}
