import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * `@graft/ask-card` — the ask card a chat product renders in place of a handoff link (GRA-84;
 * ADR 0006 as amended 2026-09-18). This entry is the server's: where the built page is, and a
 * reader for it. The page itself is `src/main.ts` over `src/render.ts`, bundled by `vite build`
 * into `dist/ask.html` (`vite.config.ts`); the shapes both sides share are `./shape`.
 *
 * Resolved off `import.meta.url` so the file is found wherever the package runs from. In this
 * repository that is `packages/ask-card/dist/ask.html`, beside the source; in the server's bundle
 * `import.meta.url` is `apps/server/dist/index.mjs`, so `../dist/ask.html` is
 * `apps/server/dist/ask.html`, where `apps/server/tsdown.config.ts` lays a copy — the same
 * arrangement as `@graft/db`'s migration chain and `@graft/runner`'s `runner.mjs`. A bundler that
 * moves this module has to carry the file with it.
 */
export const ASK_CARD_HTML_PATH = fileURLToPath(new URL("../dist/ask.html", import.meta.url));

/**
 * The built page, read once and kept: a `resources/read` per card render is the wrong moment to
 * hit the disk, and the file changes with a deploy and never else. An absent build is a sentence
 * naming the command, not a stack trace from `readFile`.
 */
let cached: Promise<string> | null = null;

export function readAskCardHtml(path: string = ASK_CARD_HTML_PATH): Promise<string> {
  if (path !== ASK_CARD_HTML_PATH) return readHtml(path);
  cached ??= readHtml(path);
  return cached;
}

async function readHtml(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `The ask card is not built at ${path} — run \`pnpm --filter @graft/ask-card build\` (the server's build copies it beside the bundle)`,
      { cause: error },
    );
  }
}

export type {
  AnswerAskAnswer,
  AnswerAskInput,
  AnswerAskRefusalReason,
  AnswerAskResult,
  AnswerOutcome,
  AskCard,
  AskCardKind,
} from "./shape";
export { ANSWER_ASK_TOOL, readAnswerOutcome, readAskCard } from "./shape";
