import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

import { renderAsk } from "./render";
import {
  ANSWER_ASK_TOOL,
  type AnswerAskInput,
  ASK_STATUS_TOOL,
  type AskStatusInput,
  readAnswerOutcome,
  readAskCard,
  readAskStatusOutcome,
  readStartLinkOutcome,
  START_LINK_TOOL,
  type StartLinkInput,
} from "./shape";

/**
 * The card's wiring to its host (GRA-84; ADR 0006 as amended 2026-09-18). One `App` over the
 * `postMessage` bridge the MCP Apps extension defines: the host tells the card the tool result it
 * was rendered for (`ui/notifications/tool-result`), the card draws the ask off
 * `structuredContent.card` — and draws nothing when the result is not an ask, since a host mounts
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
 * A render is one `AbortController`: the host may deliver another result into this same page,
 * and the poll the earlier card started must stop with it.
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

const app = new App({ name: "graft-ask-card", version: "0.2.0" }, {}, { autoResize: true });

let current: AbortController | null = null;

app.ontoolresult = (result) => {
  current?.abort();
  current = new AbortController();
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
        startLink: async (input: StartLinkInput) => {
          const started = await app.callServerTool({ name: START_LINK_TOOL, arguments: input });
          return readStartLinkOutcome(started.structuredContent);
        },
        status: async (pendingActionId) => {
          const input: AskStatusInput = { pendingActionId };
          const read = await app.callServerTool({ name: ASK_STATUS_TOOL, arguments: input });
          return readAskStatusOutcome(read.structuredContent);
        },
        openLink: async (url) => {
          await app.openLink({ url });
        },
        signal: current.signal,
      },
      document,
    ),
  );
};

app.onhostcontextchanged = (context) => applyTheme(context);

await app.connect();
applyTheme(app.getHostContext());
