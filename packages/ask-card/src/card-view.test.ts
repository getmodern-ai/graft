// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { type CardHost, createCardView, WAITING_CLASS, WAITING_TEXT } from "./card-view";
import { contentHeightOf } from "./frame-size";
import type { AskCard } from "./shape";

/**
 * The card's frame size (GRA-275, GRA-335), with the host and the `ResizeObserver` faked: before
 * any result the frame holds one waiting line at its height, never Claude's blank 150 px default,
 * and the tool's input arriving changes nothing; a result with no
 * card renders nothing and reports 0, so the host collapses the frame instead of drawing an empty
 * one; a card reports its content height on the render itself, before anything else happens; and
 * a later layout change reports again. Every report is written to `<html>` too, which is what
 * Claude.ai reads (anthropics/claude-ai-mcp#69). happy-dom lays nothing out, so the mount's box
 * is stubbed to the height a browser would measure.
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

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

const LINE = 28;

function setup(cardHeight = 412) {
  FakeObserver.instances = [];
  document.documentElement.removeAttribute("style");
  document.body.replaceChildren();
  const mount = document.createElement("div");
  mount.id = "ask";
  mount.hidden = true;
  document.body.append(mount);
  let height = cardHeight;
  const waitingOnly = () => mount.firstElementChild?.classList.contains(WAITING_CLASS) === true;
  mount.getBoundingClientRect = () =>
    ({
      height: mount.childElementCount === 0 ? 0 : waitingOnly() ? LINE : height,
    }) as DOMRect;
  const sizes: { height: number }[] = [];
  const host: CardHost = {
    callServerTool: async () => ({ structuredContent: undefined }),
    openLink: async () => undefined,
    sendSizeChanged: async (size) => {
      sizes.push(size);
    },
  };
  const view = createCardView(host, document, mount, FakeObserver);
  return {
    mount,
    sizes,
    view,
    grow: (to: number) => {
      height = to;
    },
  };
}

describe("the card's frame size", () => {
  it("measures nothing until the page asks it to", () => {
    const { sizes } = setup();
    expect(sizes).toEqual([]);
    expect(FakeObserver.instances).toEqual([]);
    expect(document.documentElement.style.height).toBe("");
  });

  it("holds one waiting line before any result, sized to the line and not to a default", () => {
    const { mount, sizes, view } = setup();
    view.waiting();
    expect(mount.hidden).toBe(false);
    expect(mount.childElementCount).toBe(1);
    expect(mount.textContent).toBe(WAITING_TEXT);
    expect(mount.firstElementChild?.getAttribute("role")).toBe("status");
    expect(sizes).toEqual([{ height: LINE }]);
    expect(document.documentElement.style.height).toBe(`${LINE}px`);
    expect(FakeObserver.instances[0]?.observed).toEqual([mount]);
  });

  it("sends the waiting height again once connected, keeping the line it shipped with", () => {
    const { mount, sizes, view } = setup();
    mount.hidden = false;
    mount.innerHTML = `<p class="${WAITING_CLASS}" role="status">${WAITING_TEXT}</p>`;
    const shipped = mount.firstElementChild;
    view.waiting();
    view.waiting();
    expect(mount.firstElementChild).toBe(shipped);
    expect(sizes).toEqual([{ height: LINE }, { height: LINE }]);
  });

  it("stays at the waiting line when the tool's input arrives before the result", () => {
    const { sizes, view } = setup();
    view.waiting();
    view.input();
    expect(sizes).toEqual([{ height: LINE }]);
    expect(document.documentElement.style.height).toBe(`${LINE}px`);
  });

  it("grows from the waiting line to the card when its result arrives", () => {
    const { mount, sizes, view } = setup(412);
    view.waiting();
    view.input();
    view.show({ structuredContent: { card: BUILD } });
    expect(mount.querySelector(`.${WAITING_CLASS}`)).toBeNull();
    expect(mount.querySelector(".ask")).not.toBeNull();
    expect(sizes).toEqual([{ height: LINE }, { height: 412 }]);
    expect(document.documentElement.style.height).toBe("412px");
    expect(FakeObserver.instances).toHaveLength(1);
  });

  it("collapses from the waiting line when the result carries no card", () => {
    const { mount, sizes, view } = setup();
    view.waiting();
    view.show({ structuredContent: { tools: [], connections: [] } });
    expect(mount.hidden).toBe(true);
    expect(mount.childElementCount).toBe(0);
    expect(sizes).toEqual([{ height: LINE }, { height: 0 }]);
    expect(document.documentElement.style.height).toBe("0px");
  });

  it("never brings the waiting line back once a result has been shown", () => {
    const { mount, sizes, view } = setup(412);
    view.waiting();
    view.show({ structuredContent: { card: BUILD } });
    view.waiting();
    view.input();
    expect(mount.querySelector(`.${WAITING_CLASS}`)).toBeNull();
    expect(sizes).toEqual([{ height: LINE }, { height: 412 }]);
  });

  it("still writes <html>'s height when the bridge is not connected yet", () => {
    const { mount } = setup();
    const throwing = createCardView(
      {
        callServerTool: async () => ({}),
        openLink: async () => undefined,
        sendSizeChanged: () => {
          throw new Error("Not connected");
        },
      },
      document,
      mount,
      FakeObserver,
    );
    expect(() => throwing.waiting()).not.toThrow();
    expect(document.documentElement.style.height).toBe(`${LINE}px`);
  });

  it("renders nothing and collapses the frame for a result with no card data", () => {
    const { mount, sizes, view } = setup();
    view.show({ structuredContent: { tools: [], connections: [] } });
    expect(mount.hidden).toBe(true);
    expect(mount.childElementCount).toBe(0);
    expect(sizes).toEqual([{ height: 0 }]);
    expect(document.documentElement.style.height).toBe("0px");
  });

  it("collapses for a result with no structured content at all", () => {
    const { sizes, view } = setup();
    view.show({});
    expect(sizes).toEqual([{ height: 0 }]);
  });

  it("sends the card's content height on its first render", () => {
    const { mount, sizes, view } = setup(412);
    view.show({ structuredContent: { card: BUILD } });
    expect(mount.hidden).toBe(false);
    expect(mount.querySelector(".ask")).not.toBeNull();
    expect(sizes).toEqual([{ height: 412 }]);
    expect(document.documentElement.style.height).toBe("412px");
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0]?.observed).toEqual([mount]);
  });

  it("reports again when the card's layout changes, and not when it does not", () => {
    const { sizes, view, grow } = setup(412);
    view.show({ structuredContent: { card: BUILD } });
    const observer = FakeObserver.instances[0];
    observer?.callback();
    expect(sizes).toEqual([{ height: 412 }]);
    grow(530);
    observer?.callback();
    expect(sizes).toEqual([{ height: 412 }, { height: 530 }]);
    expect(document.documentElement.style.height).toBe("530px");
  });

  it("collapses a frame that held a card when the next result carries none", () => {
    const { sizes, view } = setup(412);
    view.show({ structuredContent: { card: BUILD } });
    view.show({ structuredContent: { tools: [] } });
    expect(sizes).toEqual([{ height: 412 }, { height: 0 }]);
    expect(FakeObserver.instances).toHaveLength(1);
  });
});

describe("contentHeightOf", () => {
  it("is 0 for a hidden or empty mount and rounds a measured one up", () => {
    const mount = document.createElement("div");
    expect(contentHeightOf(mount)).toBe(0);
    mount.append(document.createElement("p"));
    mount.getBoundingClientRect = () => ({ height: 200.2 }) as DOMRect;
    expect(contentHeightOf(mount)).toBe(201);
    mount.hidden = true;
    expect(contentHeightOf(mount)).toBe(0);
  });
});
