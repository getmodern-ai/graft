// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { type CardHost, createCardView } from "./card-view";
import { contentHeightOf } from "./frame-size";
import type { AskCard } from "./shape";

/**
 * The card's frame size (GRA-275), with the host and the `ResizeObserver` faked: a result with no
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

function setup(cardHeight = 412) {
  FakeObserver.instances = [];
  document.documentElement.removeAttribute("style");
  document.body.replaceChildren();
  const mount = document.createElement("div");
  mount.id = "ask";
  mount.hidden = true;
  document.body.append(mount);
  let height = cardHeight;
  mount.getBoundingClientRect = () =>
    ({ height: mount.childElementCount > 0 ? height : 0 }) as DOMRect;
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
  it("sends nothing before a tool result arrives", () => {
    const { sizes } = setup();
    expect(sizes).toEqual([]);
    expect(FakeObserver.instances).toEqual([]);
    expect(document.documentElement.style.height).toBe("");
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
