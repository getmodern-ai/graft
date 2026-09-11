/**
 * Rule A of the design-token guards (ADR 0017): a colour written as a literal rather than taken
 * from a token.
 *
 * The console's tokens are Cando's, and Cando's ADR 0008 (*Figma is the source of truth*)
 * records the position both products are in: the frames are light-only, so dark mode ships
 * derived from the tokens and is *never verified per screen*. Token discipline is therefore not a
 * style preference — it is the only thing standing between a hardcoded colour and every person
 * who opens the console in dark. This is the mechanical half of that discipline, copied from
 * Cando's `packages/ui/src/tokens/colour-literals.ts` (its CAN-179) with the exception list
 * replaced by the console's own.
 *
 * Two places, because the findings this was written for were in two places:
 *
 *   * `findColourLiterals` — a literal in a component's class string or style.
 *   * `findThemeColourLiterals` — a literal inside a `@theme` block in `index.css`. Rule B
 *     cannot reach that one: a token declared there is in neither `:root` nor `.dark`, so there
 *     is no pair to compare.
 *
 * `check-token-utilities.mjs` overlaps with neither. It asserts that a token utility *resolves*
 * to something in the compiled CSS and says nothing about whether a colour *is* a token.
 *
 * Everything here is a pure function over source text. The file walking, and the tree this is
 * pointed at, live in `apps/web/scripts/check-design-tokens.mjs`.
 */

/** A colour written as a literal rather than referred to through a token. */
export type ColourLiteral = {
  /** 1-based, so it can be pasted after a `:` and opened. */
  line: number;
  /** Exactly as written — `bg-black/10`, `#fd6a41`, `rgb(0 0 0/5%)`. */
  text: string;
  kind: ColourLiteralKind;
};

export type ColourLiteralKind =
  /** A Tailwind palette utility: `bg-black/10`, `text-red-500`. Not a token in this theme. */
  | "palette"
  /** `#fff`, `#0F0C0A`, `#000000bf`. */
  | "hex"
  /** `rgb(…)`, `oklch(…)`, `color-mix(…)` with no `var(--…)` anywhere inside it. */
  | "function";

export type SourceFile = {
  /** Repo-relative, e.g. `apps/web/src/components/ui/dialog.tsx`. Used in messages. */
  path: string;
  source: string;
};

/**
 * A sanctioned exception, and the reason it is sanctioned.
 *
 * Deliberately a central list rather than an inline `// ignore` comment. An exception this rule
 * has to express is a permanent fact about a component, not a local judgement, and the failure
 * mode a guard like this dies of is being quietly switched off — so adding one has to be a
 * visible diff in one auditable place, next to every other one.
 *
 * `literals` narrows an exception to the exact strings it covers, so a file that later grows a
 * *different* literal is still reported. Omit it only where the whole file is the exception.
 */
export type ColourException = {
  /** Matched against the end of the repo-relative path. */
  file: string;
  /** The exact literals this covers. Omit to exempt every literal in the file. */
  literals?: readonly string[];
  reason: string;
};

/**
 * The one exception in this repo, documented in the file it exempts.
 *
 * It is different in kind from the exceptions Cando carries for its generated artwork: not a
 * colour that *should* be a token and currently is not, but a browser API —
 * `<meta name="theme-color">` — that structurally cannot take one. A primitive's hard-coded colour
 * is never added here; it is replaced with a token (`bg-scrim` took `bg-black/10`'s place in
 * `dialog.tsx` when this guard arrived, GRA-44).
 */
export const COLOUR_EXCEPTIONS: readonly ColourException[] = [
  {
    file: "components/theme-provider.tsx",
    literals: ["#ffffff", "#0f0c0a"],
    reason:
      '`<meta name="theme-color">`\'s content attribute is a stand-alone browser-chrome colour outside the CSS cascade, so it cannot hold a `var(--…)` reference the way every other colour in this codebase does — there is no token form for it to take. These sRGB values mirror the `--background` token in `apps/web/src/index.css` (`oklch(1 0 0)` / `oklch(0.157 0.0066 55.82)`) by hand; keep them in step with that token if it ever moves (ADR 0017).',
  },
];

/**
 * Tailwind's default palette, which is *not* this theme's palette. `transparent`, `current` and
 * `inherit` are deliberately absent: they are keywords rather than colours, they do not
 * participate in light or dark, and including them would report every `bg-transparent` that is
 * correct — which is exactly how a guard gets disabled.
 */
const PALETTE =
  "white|black|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/** The Tailwind utility namespaces that take a colour. */
const COLOUR_UTILITIES =
  "bg|text|border|ring|inset-ring|divide|outline|fill|stroke|shadow|inset-shadow|drop-shadow|from|via|to|caret|accent|decoration|placeholder";

const PALETTE_UTILITY = new RegExp(
  `(?<![\\w-])(?:${COLOUR_UTILITIES})-(?:${PALETTE})(?:-\\d{2,3})?(?:\\/\\d{1,3})?(?![\\w-])`,
  "g",
);

/**
 * 3, 4, 6 or 8 digits — the lengths CSS actually accepts.
 *
 * `_` is deliberately **not** in either lookaround. Tailwind escapes spaces inside an arbitrary
 * value as `_`, so `shadow-[0_1px_2px_#fff]` puts a word character immediately before the
 * literal; excluding `_` made every literal inside an arbitrary value invisible, which is most
 * of the interesting ones.
 */
const HEX =
  /(?<![A-Za-z0-9#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![A-Za-z0-9-])/g;

/** `color-mix` before `color`, or the shorter name wins and swallows the hyphen. */
const COLOUR_FUNCTION =
  /(?<![A-Za-z0-9-])(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color-mix|color)\(/g;

/**
 * Blank out everything that is text *about* code rather than code, keeping the offsets intact
 * so line numbers stay right.
 *
 * This is not optional decoration — it is most of what makes the rule usable. Without it, prose
 * is reported as findings: a hex quoted in a comment about what a design draws, and every
 * pull-request reference — `#139`, `#111`, `#132` are all valid three-digit hex.
 *
 * Strings are *kept*, because a class name is a string and that is the thing being checked.
 * Regex literals are blanked: a pattern is not a declaration either.
 */
export function blankNonCode(source: string): string {
  const out: string[] = [];
  /** Nesting for `${…}` inside a template literal, which is code again. */
  const templates: number[] = [];
  let i = 0;

  const keep = (n = 1) => {
    out.push(source.slice(i, i + n));
    i += n;
  };
  /** Newlines survive so line numbers do; everything else becomes a space. */
  const blankTo = (end: number) => {
    for (const ch of source.slice(i, end)) out.push(ch === "\n" ? "\n" : " ");
    i = end;
  };

  const lastSignificant = () => {
    for (let j = out.length - 1; j >= 0; j--) {
      const ch = out[j];
      if (ch && !/\s/.test(ch)) return ch;
    }
    return "";
  };

  /** `/` starts a regex only where a value cannot already have ended. */
  const regexCanStart = () => {
    const prev = lastSignificant();
    if (prev === "") return true;
    if ("(,=:[!&|?{};+-*%~^<>".includes(prev)) return true;
    // `return /re/`, `typeof /re/` — a word before a `/` is otherwise division.
    return /\breturn\s*$|\bcase\s*$|\btypeof\s*$|\bin\s*$|\bof\s*$/.test(out.join("").slice(-10));
  };

  const readString = (quote: string) => {
    keep(); // the opening quote
    while (i < source.length) {
      if (source[i] === "\\") {
        keep(2);
        continue;
      }
      if (source[i] === quote) {
        keep();
        return;
      }
      keep();
    }
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (templates.length > 0 && templates[templates.length - 1] === 0) {
      // Inside the text part of a template literal.
      if (ch === "\\") {
        keep(2);
        continue;
      }
      if (ch === "$" && next === "{") {
        // `-1` is the expression at brace depth zero; each nested `{` goes one lower.
        templates.push(-1);
        keep(2);
        continue;
      }
      if (ch === "`") {
        templates.pop();
        keep();
        continue;
      }
      keep();
      continue;
    }

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blankTo(end === -1 ? source.length : end);
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      blankTo(end === -1 ? source.length : end + 2);
      continue;
    }
    if (ch === '"' || ch === "'") {
      readString(ch);
      continue;
    }
    if (ch === "`") {
      templates.push(0);
      keep();
      continue;
    }
    // Read once: `noUncheckedIndexedAccess` is on, and the two brace handlers below both need the
    // top of the stack narrowed to a number before comparing it to anything but a literal.
    const top = templates.length > 0 ? templates[templates.length - 1] : undefined;

    if (ch === "{" && top !== undefined && top < 0) {
      templates[templates.length - 1] = top - 1;
      keep();
      continue;
    }
    if (ch === "}" && top !== undefined && top < 0) {
      // Only the brace that closes the interpolation itself ends it. Without the depth count a
      // callback body inside `${…}` ends the interpolation early; template text is kept verbatim
      // and both `${` and the closing backtick are recognised there, so the scanner would
      // re-synchronise within a few characters, but the state would be briefly wrong.
      if (top === -1) templates.pop();
      else templates[templates.length - 1] = top + 1;
      keep();
      continue;
    }
    if (ch === "/" && regexCanStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") {
          j = -1;
          break;
        }
        j++;
      }
      if (j > 0 && j < source.length) {
        blankTo(j + 1);
        continue;
      }
    }
    keep();
  }

  return out.join("");
}

/**
 * Blank the value of an attribute selector, e.g. `[stroke='#fff']`.
 *
 * The one construct where a hex is not a colour being set but a colour being *matched*: a
 * selector that targets a library's own hardcoded output in order to override it, which is the
 * opposite of the problem. Cando's chart primitive carries five of these.
 */
export function blankSelectorValues(source: string): string {
  return source.replace(
    /(\[[\w-]+[~|^$*]?=)("[^"\n]*"|'[^'\n]*')/g,
    (_all, head: string, value: string) => head + value.replace(/[^\s]/g, " "),
  );
}

/** Read a balanced `(…)` starting at `open`. Returns the index just past the `)`. */
function endOfCall(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

const lineOf = (source: string, index: number) => {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
};

/**
 * Every colour literal in one file's source, in the order they appear.
 *
 * A colour function whose arguments mention `var(--…)` anywhere is *not* a literal: it is a
 * token with something done to it. That is what lets `button.tsx` keep
 * `color-mix(in oklch, var(--secondary), var(--foreground) 5%)` — it derives from a token and
 * therefore responds to the theme, which is the whole thing being protected.
 */
export function findColourLiterals(source: string): ColourLiteral[] {
  const code = blankSelectorValues(blankNonCode(source));
  const found: ColourLiteral[] = [];

  for (const match of code.matchAll(PALETTE_UTILITY)) {
    found.push({ line: lineOf(code, match.index), text: match[0], kind: "palette" });
  }
  for (const match of code.matchAll(HEX)) {
    found.push({ line: lineOf(code, match.index), text: match[0], kind: "hex" });
  }
  for (const match of code.matchAll(COLOUR_FUNCTION)) {
    const open = match.index + match[0].length - 1;
    const call = code.slice(match.index, endOfCall(code, open));
    if (call.includes("var(--")) continue;
    found.push({
      line: lineOf(code, match.index),
      // Class strings escape spaces as `_`; normalise so a message is readable.
      text: call.replace(/\s+/g, " "),
      kind: "function",
    });
  }

  return found.sort((a, b) => a.line - b.line || a.text.localeCompare(b.text));
}

/** Blank `/* … *​/` while keeping offsets, so a CSS line number stays right. */
export function blankCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Colour literals inside a `@theme` block, where having a mode is impossible.
 *
 * The finding neither of the other rules can see. Cando's shadow tokens were once declared as
 * literal `oklch(0 0 0 / …%)` *inside* `@theme`, which is outside both `:root` and `.dark` — so
 * they had no dark counterpart at all, and Rule B never saw them because it only compares tokens
 * declared in both. A `:root`-only token cannot be forbidden in general: Cando's ten `--agent-*`
 * tints are deliberately mode-invariant, and such a rule would report ten correct tokens.
 *
 * `@theme` is narrower and admits no exception. It exists to lift values into Tailwind's
 * namespaces, and a colour written there can never respond to a theme — so it is always wrong,
 * and the fix is always the same: declare the value in `:root`/`.dark` and leave the `@theme`
 * entry holding a `var()` — which is what every colour in the managed block already does, pairing
 * `--primary` with `--color-primary`. That is why this needs no exception list: the shape it
 * demands is the shape the file is already written in, and the only non-`var()` entries the
 * block holds are four font stacks and the radius arithmetic, which contain no colour.
 */
export function findThemeColourLiterals(css: string): ColourLiteral[] {
  const blanked = blankCssComments(css);
  const found: ColourLiteral[] = [];

  for (const at of blanked.matchAll(/@theme\b[^{]*\{/g)) {
    const open = blanked.indexOf("{", at.index);
    let depth = 0;
    let close = blanked.length;
    for (let i = open; i < blanked.length; i++) {
      if (blanked[i] === "{") depth++;
      else if (blanked[i] === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    // Keep the offsets absolute so line numbers refer to the file, not the block.
    const body = " ".repeat(open + 1) + blanked.slice(open + 1, close);

    for (const match of body.matchAll(HEX)) {
      found.push({ line: lineOf(blanked, match.index), text: match[0], kind: "hex" });
    }
    for (const match of body.matchAll(COLOUR_FUNCTION)) {
      const start = match.index + match[0].length - 1;
      const call = body.slice(match.index, endOfCall(body, start));
      if (call.includes("var(--")) continue;
      found.push({
        line: lineOf(blanked, match.index),
        text: call.replace(/\s+/g, " "),
        kind: "function",
      });
    }
  }

  return found.sort((a, b) => a.line - b.line || a.text.localeCompare(b.text));
}

const exceptionFor = (
  path: string,
  literal: ColourLiteral,
  exceptions: readonly ColourException[],
) =>
  exceptions.find(
    (e) => path.endsWith(e.file) && (e.literals === undefined || e.literals.includes(literal.text)),
  );

/**
 * Every unsanctioned colour literal across the given files, as lines ready to print.
 *
 * Empty means the rule is satisfied. Non-empty must fail the build rather than warn: `biome ci`
 * exits 0 on warnings — the reason `noFocusedTests` is promoted to `error` in `biome.json` — and a
 * guard nobody's build stops for is a comment.
 */
export function checkColourLiterals(
  files: readonly SourceFile[],
  exceptions: readonly ColourException[] = COLOUR_EXCEPTIONS,
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const literal of findColourLiterals(file.source)) {
      if (exceptionFor(file.path, literal, exceptions)) continue;
      problems.push(`${file.path}:${literal.line}  ${literal.text}  (${literal.kind})`);
    }
  }
  return problems;
}

/**
 * Exceptions that no longer match anything.
 *
 * A stale entry is how an exception list turns into a place colours go to hide: the literal it
 * was written for is gone, the entry stays, and it silently covers the next one to appear at
 * that path. Reported alongside the findings so the list has to stay true.
 */
export function findStaleExceptions(
  files: readonly SourceFile[],
  exceptions: readonly ColourException[] = COLOUR_EXCEPTIONS,
): string[] {
  const used = new Set<ColourException>();
  for (const file of files) {
    for (const literal of findColourLiterals(file.source)) {
      const hit = exceptionFor(file.path, literal, exceptions);
      if (hit) used.add(hit);
    }
  }
  return exceptions
    .filter((e) => !used.has(e))
    .map((e) => `${e.file}${e.literals ? `  ${e.literals.join(", ")}` : ""}`);
}
