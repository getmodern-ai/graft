import { GraftMark } from "@/components/graft-mark";

/**
 * The band every pre-auth screen opens with — `/login` and `/signup` share it, so the two doors
 * read as one.
 *
 * Centred below `md`, flush left above it, in Cando's `mt-4`/`px-4` and `md:mt-6`/`md:px-8` bands
 * (its `apps/web/src/components/auth/auth-header.tsx`, CAN-355). Cando draws a wordmark image at
 * `h-8`; Graft has a mark and no wordmark, so the mark is drawn at that height with the name in
 * text beside it — the same pairing the sidebar's header uses.
 */
function AuthHeader() {
  return (
    <header className="mt-4 flex h-9 shrink-0 items-center justify-center px-4 md:mt-6 md:justify-start md:px-8">
      <span className="flex items-center gap-2.5 font-semibold text-lg tracking-tight">
        <GraftMark className="size-8" />
        Graft
      </span>
    </header>
  );
}

export { AuthHeader };
