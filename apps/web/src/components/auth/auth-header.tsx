import { GraftWordmark } from "@/components/graft-wordmark";

/**
 * The band every pre-auth screen opens with — `/login` and `/signup` share it, so the two doors
 * read as one.
 *
 * Centred below `md`, flush left above it, in Cando's `mt-4`/`px-4` and `md:mt-6`/`md:px-8` bands
 * (its `apps/web/src/components/auth/auth-header.tsx`, CAN-355). The Graft wordmark uses the same
 * `h-8` as Cando's, with its proportions preserved (GRA-108).
 */
function AuthHeader() {
  return (
    <header className="mt-4 flex h-9 shrink-0 items-center justify-center px-4 md:mt-6 md:justify-start md:px-8">
      <GraftWordmark />
    </header>
  );
}

export { AuthHeader };
