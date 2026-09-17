import { CheckCircleIcon, DangerousIcon, type IconProps, WarningIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Where a popup ends, for the OAuth consent (`routes/oauth.callback.tsx`, GRA-48) and for a
 * provider's link (`routes/link.callback.tsx`, GRA-59): one page in Cando's empty-state shape — an
 * icon, a sentence-case title with no full stop, one sentence of description, the server's own when
 * it sent one and these when the address carried none — and a Close button. Composed rather than
 * matched to a frame (ADR 0017): Cando's `connections.callback.tsx` is the nearest screen, and its
 * `route-not-found.tsx` the voice. The routes own what happens on landing — the announcement to
 * the waiting console, the close timer — and hand this the outcome to draw.
 */

export type CallbackOutcomeStatus = "connected" | "declined" | "failed";

const OUTCOMES: Record<
  CallbackOutcomeStatus,
  { title: string; Icon: (props: IconProps) => React.JSX.Element; fallback: string }
> = {
  connected: {
    title: "Connected",
    Icon: CheckCircleIcon,
    fallback: "The connection is ready — the console updates on its own.",
  },
  declined: {
    title: "Not connected",
    Icon: WarningIcon,
    fallback: "You declined — nothing was stored.",
  },
  failed: {
    title: "Something went wrong",
    Icon: DangerousIcon,
    fallback:
      "This did not complete — nothing was stored, and you can connect again from the console.",
  },
};

/** The outcome's title, for a route's `head`. */
export function callbackOutcomeTitle(status: CallbackOutcomeStatus): string {
  return OUTCOMES[status].title;
}

export function CallbackOutcomePage({
  status,
  message,
  onClose,
}: {
  status: CallbackOutcomeStatus;
  message: string;
  onClose: () => void;
}) {
  const { title, Icon, fallback } = OUTCOMES[status];
  return (
    <main className="flex min-h-svh flex-col">
      <Empty className="mx-auto h-full max-w-md px-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{message || fallback}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={onClose}>Close this window</Button>
      </Empty>
    </main>
  );
}
