import * as React from "react";

/**
 * The mounted screen's title, as the shell's two bars show it: the 48px page strip at `md` and
 * up, and the mobile top bar below it (`app-shell.tsx`, `mobile-top-bar.tsx`). A screen calls
 * `useScreenTitle` with what the bars should say — a plain string for a list screen, a breadcrumb
 * of parent link, slash and `PageNavSubPageTitle` for a detail screen — and the bars read it back
 * through the same context, so a title is written once and the two surfaces cannot disagree.
 *
 * This is Cando's `useMobileTopBar` slot (`apps/web/src/components/shell/mobile-top-bar.tsx`,
 * its CAN-352) under a name that says what it feeds here. Cando's strip is mounted per screen,
 * because its screens' strips differ — tabs on automations, an editable thread title on chat —
 * and each fills the mobile bar separately; the console's screens differ only in the title, so
 * the shell mounts one strip and both bars read this one slot. One consequence: no screen can
 * forget the collapsed-sidebar toggle, which is the omission Cando's `sidebar-collapse.test.tsx`
 * exists to catch.
 *
 * Two contexts, not one holding both fields — Cando's split, kept for the reason it records.
 * `useScreenTitle` only ever *writes*, but `React.useContext` subscribes its caller to the whole
 * value a context carries. A single `{ title, setTitle }` context would re-render every screen
 * that sets a title on every title change, including its own: the effect below depends on
 * `title`, which is a fresh object on every render whenever a caller passes inline JSX, so the
 * re-render re-runs the effect, which sets again, forever. The setter in its own context — the
 * `useState` setter, referentially stable for the provider's lifetime — breaks the cycle.
 *
 * Defaulted rather than `null`, so the bars and the hook both work — the hook as a harmless
 * no-op — without a provider in the tree.
 */
const ScreenTitleContext = React.createContext<React.ReactNode>(null);
const SetScreenTitleContext = React.createContext<
  React.Dispatch<React.SetStateAction<React.ReactNode>>
>(() => {});

export function ScreenTitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = React.useState<React.ReactNode>(null);

  return (
    <SetScreenTitleContext.Provider value={setTitle}>
      <ScreenTitleContext.Provider value={title}>{children}</ScreenTitleContext.Provider>
    </SetScreenTitleContext.Provider>
  );
}

/**
 * Sets the shell's title from wherever a screen renders. Registers on mount and on every change
 * to what was passed, and clears itself on unmount: a screen that stops rendering — a navigation
 * away, an error boundary — must not leave its title standing over the next one.
 *
 * `useLayoutEffect`, not `useEffect`. The bars persist across navigations while the screen under
 * them is swapped, so a passive effect — which runs after the browser may have painted — lets the
 * strip show the previous screen's title, or nothing on first load, for one frame above the new
 * content. A layout effect runs synchronously after commit and before paint, and the leaving
 * screen's cleanup and the arriving screen's setup land in the same commit, so the bars re-render
 * with the new title before anything is drawn (Greptile on PR #28; Cando's `useMobileTopBar` pays
 * that frame, and `theme-provider.tsx` here already takes the same route for the same reason).
 *
 * A string is drawn in the bars' own type (`ScreenTitle` below); a node is drawn as passed, which
 * is how a detail screen composes its breadcrumb.
 */
export function useScreenTitle(title: React.ReactNode) {
  const setTitle = React.useContext(SetScreenTitleContext);

  React.useLayoutEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
}

/** What the bars render: the screen's title in the strip's type, or nothing until a screen sets one. */
export function ScreenTitle() {
  const title = React.useContext(ScreenTitleContext);

  if (typeof title === "string") {
    return <span className="truncate font-medium text-base">{title}</span>;
  }
  return title;
}
