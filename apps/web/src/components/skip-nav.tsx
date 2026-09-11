/**
 * The id the shell's `<main>` carries, and the anchor `SkipNav` points at. One constant rather
 * than the string written twice, so the link and its target cannot drift apart.
 */
export const MAIN_CONTENT_ID = "main-content";

/**
 * A keyboard-only escape hatch from the shell's persistent chrome — the sidebar in `AppShell` —
 * straight to the screen's own content. A mouse user skips the sidebar by pointing at what they
 * want; a keyboard user without one would otherwise tab through every sidebar row first, on
 * *every* screen, before reaching it.
 *
 * `sr-only` until it has focus, then `not-sr-only` and pinned to the corner — the standard
 * "skip navigation" pattern: invisible to a sighted mouse user, and the first stop for a
 * keyboard user's very first Tab, because it has to be the first focusable element in the shell.
 *
 * Cando's `apps/web/src/components/skip-nav.tsx`, unchanged but for this comment (GRA-46).
 */
export function SkipNav() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={() => {
        // Following a fragment link is supposed to focus its target when the target is
        // focusable, but that is inconsistent across browsers (Safari in particular) — so the
        // target's own `tabIndex={-1}` is claimed explicitly rather than left to chance.
        document.getElementById(MAIN_CONTENT_ID)?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:text-sm focus:shadow-lg focus:outline-none focus:ring-3 focus:ring-ring/50"
    >
      Skip to main content
    </a>
  );
}
