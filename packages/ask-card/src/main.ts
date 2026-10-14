import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

import { createCardView } from "./card-view";

/**
 * The card's wiring to its host (GRA-84; ADR 0006 as amended 2026-09-18). One `App` over the
 * `postMessage` bridge the MCP Apps extension defines: the host tells the card the tool result it
 * was rendered for (`ui/notifications/tool-result`), the card draws the ask, or `find_tool`'s
 * Setup offer (GRA-210), off `structuredContent.card` — and draws nothing when the result carries
 * neither, since a host mounts
 * the same page for every result of a tool that names it — and the person's click goes back as a
 * `tools/call` of `answer_ask`, which the host forwards to Graft under the agent's own session.
 * Two more calls take the same road (GRA-117, GRA-118): `start_link`, which mints a link
 * provider's sign-in for the ask, and `ask_status`, which the card polls once the person has been
 * sent to a page it cannot hear from. Nothing leaves the iframe by any other route: no fetch, no
 * cookie, no origin to allow.
 *
 * The card never sends `ui/message`: what the agent says next is the agent's to say, and the
 * playbook already has it call the same tool again. `ui/open-link` is the one other call, for the
 * page the person finishes on — Claude shows its confirmation once, ChatGPT opens a tab (the
 * GRA-84 research).
 *
 * The render and its size report are `card-view.ts`. `autoResize` is off: the card reports its
 * own height (`frame-size.ts`, GRA-275): the waiting line's before any result, on the page's first
 * run and again once the bridge is connected (GRA-335), then each result's.
 */

const mount = document.getElementById("ask");
if (!mount) throw new Error("the page has no #ask element");

function applyTheme(context: McpUiHostContext | undefined): void {
  const theme =
    context?.theme ??
    (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyDocumentTheme(theme);
  // The stylesheet's dark block is `.dark` on the root, as the console's is (ADR 0017).
  document.documentElement.classList.toggle("dark", theme === "dark");
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

const app = new App({ name: "graft-ask-card", version: "0.4.0" }, {}, { autoResize: false });

const view = createCardView(app, document, mount);
// `<html>`'s height is written now, before the handshake; the notification goes after it.
view.waiting();
app.ontoolinput = () => view.input();
app.ontoolresult = (result) => view.show(result);

app.onhostcontextchanged = (context) => applyTheme(context);

await app.connect();
applyTheme(app.getHostContext());
view.waiting();
