import { Spinner } from "@/components/ui/spinner";

export function Loader() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center pt-8 text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  );
}
