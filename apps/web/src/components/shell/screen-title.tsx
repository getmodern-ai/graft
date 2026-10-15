import * as React from "react";

/**
 * The mounted screen's title, as the mobile top bar shows it below `md` (`mobile-top-bar.tsx`). A
 * screen calls `useScreenTitle` with a plain string, the list's name or the record's, and the bar
 * reads it back through the same context. At `md` and up nothing reads it: App v2 has no page
 * strip, and every screen's own `PageHeader` carries its title, a detail screen's with a
 * breadcrumb above it (`page/page-breadcrumb.tsx`, GRA-344). It does not set `document.title`,
 * which the root route's `head` holds.
 *
 * This is Cando's `useMobileTopBar` slot (`apps/web/src/components/shell/mobile-top-bar.tsx`,
 * its CAN-352) under a name that says what it feeds here, narrowed to a string: the breadcrumb a
 * detail screen used to pass lives in the page now.
 *
 * Two contexts, not one holding both fields — Cando's split, kept for the reason it records.
 * `useScreenTitle` only ever *writes*, but `React.useContext` subscribes its caller to the whole
 * value a context carries. A single `{ title, setTitle }` context would re-render every screen
 * that sets a title on every title change, including its own. Since the title is a string the
 * effect below no longer loops on it (it did while a caller could pass inline JSX, a fresh object
 * every render), but the split still spares every screen a re-render it has no use for.
 *
 * Defaulted rather than `null`, so the bar and the hook both work — the hook as a harmless
 * no-op — without a provider in the tree.
 */
const ScreenTitleContext = React.createContext<string | null>(null);
const SetScreenTitleContext = React.createContext<
  React.Dispatch<React.SetStateAction<string | null>>
>(() => {});

export function ScreenTitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = React.useState<string | null>(null);

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
 * `useLayoutEffect`, not `useEffect`. The bar persists across navigations while the screen under
 * it is swapped, so a passive effect — which runs after the browser may have painted — lets the
 * bar show the previous screen's title, or nothing on first load, for one frame above the new
 * content. A layout effect runs synchronously after commit and before paint, and the leaving
 * screen's cleanup and the arriving screen's setup land in the same commit, so the bar re-renders
 * with the new title before anything is drawn (Greptile on PR #28; Cando's `useMobileTopBar` pays
 * that frame, and `theme-provider.tsx` here already takes the same route for the same reason).
 */
export function useScreenTitle(title: string) {
  const setTitle = React.useContext(SetScreenTitleContext);

  React.useLayoutEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
}

/** What the mobile bar renders: the screen's title, or nothing until a screen sets one. */
export function ScreenTitle() {
  const title = React.useContext(ScreenTitleContext);

  return title ? <span className="truncate font-medium text-base">{title}</span> : null;
}
