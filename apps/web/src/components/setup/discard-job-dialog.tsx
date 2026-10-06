import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * The one confirmation going back can lead to (GRA-215): a record that went back keeps its job
 * running, and only a forward action that replaces it, another integration or Build with another
 * task, leaves it behind. The server refuses such an action `job_running` until it says
 * `discardJob`, and this is where the person says so. Cando's `AlertDialog` shape, as
 * `revoke-agent-dialog.tsx` draws it: the title asks, the description says what goes and what
 * stays, Cancel first, the action last with a present participle while pending.
 */
export function DiscardJobDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
  action,
  consequence,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
  /** The button's verb, and its participle while the request runs. */
  action: { label: string; pending: string };
  /** What the choice does, one sentence. */
  consequence: string;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next || !pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave the running job behind?</AlertDialogTitle>
          <AlertDialogDescription>
            Graft is still acquiring the tool you asked for. {consequence} The job finishes on its
            own, and a tool it lands stays in your agent's tools, but Setup stops following it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {pending ? action.pending : action.label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
