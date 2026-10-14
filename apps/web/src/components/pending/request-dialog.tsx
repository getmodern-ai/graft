import { FocusedAskFrame } from "@/components/pending/focused-ask-card";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { PendingAction } from "@/lib/pending-action-queries";

/**
 * One request opened in place (GRA-311; frame 2108:13707): the kind's focused layout, the one the
 * handoff page draws (GRA-314), so an ask answered here and one answered from the agent's link read
 * and write the same. A tool ask carries the how-much radio and the ask-every-call tick; a
 * connection or scope ask *Full access* / *Ask me first*. The card is the dialog's whole body and
 * its question the visible title, so the dialog's own title is for assistive technology alone.
 * Closes once the ask is answered.
 */
export function RequestDialog({
  action,
  title,
  open,
  onOpenChange,
}: {
  action: PendingAction;
  /** The row's sentence, naming the dialog for a screen reader. */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] p-6 sm:max-w-[480px] md:p-8">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <FocusedAskFrame.Provider value="dialog">
          <PendingActionCard
            action={action}
            layout="focused"
            onAnswered={() => onOpenChange(false)}
          />
        </FocusedAskFrame.Provider>
      </DialogContent>
    </Dialog>
  );
}
