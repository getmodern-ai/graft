import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

import { renderAsk } from "./render";
import { ANSWER_ASK_TOOL, type AnswerAskInput, readAnswerOutcome, readAskCard } from "./shape";

/**
 * The card's wiring to its host (GRA-84; ADR 0006 as amended 2026-09-18). One `App` over the
 * `postMessage` bridge the MCP Apps extension defines: the host tells the card the tool result it
 * was rendered for (`ui/notifications/tool-result`), the card draws the ask off
 * `structuredContent.card` — and draws nothing when the result is not an ask, since a host mounts
 * the same page for every result of a tool that names it — and the person's click goes back as a
 * `tools/call` of `answer_ask`, which the host forwards to Graft under the agent's own session.
 * Nothing leaves the iframe by any other route: no fetch, no cookie, no origin to allow.
 *
 * The card never sends `ui/message`: what the agent says next is the agent's to say, and the
 * playbook already has it call the same tool again. `ui/open-link` is the one other call, for the
 * console button on an ask the card may not answer.
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

const app = new App({ name: "graft-ask-card", version: "0.1.0" }, {}, { autoResize: true });

app.ontoolresult = (result) => {
  const card = readAskCard(result.structuredContent);
  mount.replaceChildren();
  if (!card) {
    mount.hidden = true;
    return;
  }
  mount.hidden = false;
  mount.append(
    renderAsk(
      card,
      {
        answer: async (answer) => {
          const input: AnswerAskInput = { pendingActionId: card.pendingActionId, answer };
          const answered = await app.callServerTool({ name: ANSWER_ASK_TOOL, arguments: input });
          return readAnswerOutcome(answered.structuredContent);
        },
        openConsole: async (url) => {
          await app.openLink({ url });
        },
      },
      document,
    ),
  );
};

app.onhostcontextchanged = (context) => applyTheme(context);

await app.connect();
applyTheme(app.getHostContext());
