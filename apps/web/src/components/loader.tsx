import { ProgressActivityIcon } from "@/components/icons";

/** The route-level pending state (`main.tsx`) — Cando's `apps/web/src/components/loader.tsx`. */
export function Loader() {
  return (
    <div className="flex h-full items-center justify-center pt-8">
      <ProgressActivityIcon className="animate-spin" />
    </div>
  );
}
