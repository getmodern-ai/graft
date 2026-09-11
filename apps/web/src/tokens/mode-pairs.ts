/**
 * Rule B of the design-token guards (ADR 0017): a base token identical across modes while its
 * derived family flips. Copied from Cando's `packages/ui/src/tokens/mode-pairs.ts` (its CAN-179,
 * inherited from its CAN-130), and unchanged in logic — the tokens it reads are Cando's, copied
 * verbatim into `apps/web/src/index.css`, so the shapes it has to leave alone are the same.
 *
 * **Identity alone cannot be the criterion, and that is the whole difficulty.** Of the pairs in the
 * managed block, fifteen are identical on purpose: the six `--custom-brand-*`, `--primary` and
 * `--primary-foreground` (deliberately dark text on orange in both modes), `--chart-chart-1`,
 * `--sidebar-primary`, `--sidebar-primary-foreground`, two `--custom-bg-primary-*` tints,
 * `--custom-switch-on-thumb-bg` and `--destructive-foreground`. A rule that forbade identity would
 * report all fifteen and be switched off in a week.
 *
 * What made Cando's `--destructive` bug detectable is narrower and mechanical. Before the fix it
 * was `oklch(0.531 0.1933 25.14)` in *both* modes, while every token derived from it —
 * `--custom-bg-destructive-10/20`, `--custom-destructive-70/90`,
 * `--custom-destructive-border-40`, `--custom-destructive-focus` — carried
 * `oklch(0.63 0.2294 25.06)` in dark. The family had moved to brand red/500 and the base had been
 * left behind. That is the shape this looks for, and it needs no exception list to leave the
 * fifteen alone: they are silent by construction, which is a stronger property than being
 * allowlisted. The mechanism for an exception exists anyway, because the day it is needed is not
 * the day to design it.
 *
 * Two decisions do the work of that construction:
 *
 *   * **Alpha is not part of the colour.** `--custom-bg-primary-5` is 5% in light and 10% in dark
 *     over the *same* `oklch(0.68 0.2071 36.25)`; a mode is allowed to tune a tint's weight for
 *     its substrate, and reading that as a flip would report `--primary`. It is the `L C H`
 *     triple that must not move under a base that did not.
 *   * **A family is a name relationship**, on whole hyphen-delimited segments. `primary` is
 *     derived-in by `custom-bg-primary-5` and `sidebar-primary`, but `destructive-foreground` is
 *     *not* a family member of `destructive-foreground`'s own base `destructive` in reverse — the
 *     containment only runs one way, which is why `--destructive-foreground` being identical in
 *     both modes reports nothing.
 *
 * Pure functions over CSS text; the file reading lives in
 * `apps/web/scripts/check-design-tokens.mjs`.
 */

/** One token that is declared in both `:root` and `.dark`. */
export type ModePair = {
  /** Without the leading `--`, e.g. `custom-bg-destructive-10`. */
  name: string;
  light: string;
  dark: string;
};

export type ModeException = {
  /** Base token name, without the leading `--`. */
  token: string;
  reason: string;
};

/**
 * Empty, and that is the finding rather than an oversight.
 *
 * Every legitimately-identical pair is silent under the criterion above without being named
 * here. `mode-pairs.test.ts` pins each shape that has to stay silent — the alpha-tuned `--primary`
 * family, the two `*-foreground` pairs, a `--custom-brand-*` with no family at all — and the CLI
 * is what asserts it over the real `index.css`. An allowlist entry that is not needed is worse
 * than none: it is a place a real flip can be parked later without anyone re-deriving whether it
 * belonged.
 *
 * If an entry is ever needed, it goes here with its reason, and `checkModePairs` honours it — the
 * mechanism has its own test rather than waiting for a first user.
 */
export const MODE_EXCEPTIONS: readonly ModeException[] = [];

/** Top-level blocks whose declarations are the light and dark sides of the theme. */
const LIGHT_SELECTOR = ":root";
const DARK_SELECTOR = ".dark";

/** Read a balanced `{…}` starting at `open`. Returns the index of the matching `}`. */
function endOfBlock(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/**
 * Every `--name: value` declared directly inside blocks with the given selector, merged in source
 * order so a later block wins — which is what the cascade does, since `:root` and `.dark` have
 * equal specificity.
 */
function declarationsFor(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = new RegExp(`(?:^|[}\\n;]|\\*/)\\s*${selector.replace(".", "\\.")}\\s*\\{`, "g");

  for (const match of css.matchAll(pattern)) {
    const open = css.indexOf("{", match.index);
    // Comments go **before** the split, not after. This file's comments are prose, and prose has
    // semicolons in it — `A scrim dims what is behind it; --foreground would invert…` split one
    // declaration into three and lost `--scrim` entirely when it was the other way round.
    const body = css.slice(open + 1, endOfBlock(css, open)).replace(/\/\*[\s\S]*?\*\//g, " ");

    // Split on `;` that are not inside `(…)`, so `oklch(0 0 0 / 5%), 0 1px …` survives.
    let depth = 0;
    let start = 0;
    const pieces: string[] = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
      else if (body[i] === ";" && depth === 0) {
        pieces.push(body.slice(start, i));
        start = i + 1;
      }
    }
    pieces.push(body.slice(start));

    for (const piece of pieces) {
      const colon = piece.indexOf(":");
      if (colon === -1) continue;
      const name = piece.slice(0, colon).trim();
      if (!name.startsWith("--")) continue;
      found.set(
        name.slice(2),
        piece
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, " "),
      );
    }
  }
  return found;
}

/** Every token declared in both modes. A `:root`-only token is a different question. */
export function parseModePairs(css: string): ModePair[] {
  const light = declarationsFor(css, LIGHT_SELECTOR);
  const dark = declarationsFor(css, DARK_SELECTOR);
  const pairs: ModePair[] = [];
  for (const [name, lightValue] of light) {
    const darkValue = dark.get(name);
    if (darkValue !== undefined) pairs.push({ name, light: lightValue, dark: darkValue });
  }
  return pairs.sort((a, b) => a.name.localeCompare(b.name));
}

const COLOUR_CALL = /\b(rgba?|hsla?|hwb|oklch|oklab|lch|lab)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/**
 * The value with every colour's alpha removed, so two values compare on colour alone.
 *
 * Handles both spellings CSS allows: the modern `oklch(L C H / A)` slash form the managed block
 * uses, and the legacy `rgba(r, g, b, a)` fourth argument.
 */
export function withoutAlpha(value: string): string {
  return value
    .replace(COLOUR_CALL, (_all, fn: string, args: string) => {
      const slash = args.indexOf("/");
      if (slash !== -1) return `${fn}(${args.slice(0, slash).trim()})`;
      const parts = args.split(",");
      if (parts.length === 4) return `${fn}(${parts.slice(0, 3).join(",").trim()})`;
      return `${fn}(${args.trim()})`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** A pair whose colour — ignoring alpha — is the same on both sides. */
export const isModeIdentical = (pair: ModePair) =>
  withoutAlpha(pair.light) === withoutAlpha(pair.dark);

/**
 * Whether `candidate` is derived from `base` by name: every segment of `base`, contiguous and in
 * order, somewhere in `candidate`'s segments, and not `base` itself.
 */
export function isDerivedFrom(candidate: string, base: string): boolean {
  if (candidate === base) return false;
  const target = base.split("-");
  const segments = candidate.split("-");
  if (segments.length <= target.length) return false;
  outer: for (let i = 0; i + target.length <= segments.length; i++) {
    for (let j = 0; j < target.length; j++) if (segments[i + j] !== target[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Every base token that did not move between modes while something derived from it did.
 *
 * Empty means the rule is satisfied. Non-empty must fail the build, because a warning is not a
 * guard.
 */
export function checkModePairs(
  pairs: readonly ModePair[],
  exceptions: readonly ModeException[] = MODE_EXCEPTIONS,
): string[] {
  const problems: string[] = [];
  for (const base of pairs) {
    if (!isModeIdentical(base)) continue;
    if (exceptions.some((e) => e.token === base.name)) continue;
    const flipped = pairs.filter((p) => isDerivedFrom(p.name, base.name) && !isModeIdentical(p));
    if (flipped.length === 0) continue;
    problems.push(
      `--${base.name} is ${withoutAlpha(base.light)} in both modes, but ${flipped.length} token${
        flipped.length === 1 ? "" : "s"
      } derived from it flip: ${flipped
        .map((p) => `--${p.name} (${withoutAlpha(p.light)} → ${withoutAlpha(p.dark)})`)
        .join(", ")}`,
    );
  }
  return problems;
}
