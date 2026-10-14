import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";

import { RetryNotice } from "@/components/retry-notice";
import { SettingsButtonRow, SettingsEmptyRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PASSWORD_ROW,
  type PasswordDraft,
  type PasswordField,
  type PasswordMode,
  passwordDraftProblem,
  passwordModeOf,
} from "@/lib/password";
import {
  accountKeys,
  accountsQuery,
  changePassword,
  setFirstPassword,
} from "@/lib/password-queries";

/**
 * Settings › Account › Password (GRA-298; Figma 2100:10414): *Set a password* for a person who
 * signed up with Google or GitHub, *Change password* for one who holds a password. The row owns its
 * read of the accounts, so a first read pending is a skeleton row and one failed with nothing to
 * show a `RetryNotice` in the row's place; a background refetch that fails keeps the row as last
 * read. The dialog is mounted per opening, beside the row rather than inside its branches, so no
 * read's outcome unmounts an open draft (Greptile on #230), and its mode is the one the person
 * opened it in, so the invalidation after a save does not retitle it while it closes.
 */
export function PasswordRow() {
  const read = useQuery(accountsQuery);
  const [openMode, setOpenMode] = useState<PasswordMode | null>(null);

  let row: React.ReactNode;
  if (read.data !== undefined) {
    const mode = passwordModeOf(read.data);
    row = (
      <SettingsButtonRow
        title={PASSWORD_ROW.title}
        description={PASSWORD_ROW.description}
        action={
          <Button variant="outline" onClick={() => setOpenMode(mode)}>
            {PASSWORD_ROW.action[mode]}
          </Button>
        }
      />
    );
  } else if (read.isError) {
    row = (
      <SettingsEmptyRow>
        <p className="text-muted-foreground text-sm">
          <RetryNotice
            error={read.error}
            message="Could not load how you sign in."
            onRetry={() => void read.refetch()}
            retrying={read.isFetching}
          />
        </p>
      </SettingsEmptyRow>
    );
  } else {
    row = (
      <SettingsEmptyRow>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-28" />
      </SettingsEmptyRow>
    );
  }

  return (
    <>
      {row}
      {openMode ? <PasswordDialog mode={openMode} onClose={() => setOpenMode(null)} /> : null}
    </>
  );
}

const DIALOG_COPY: Record<PasswordMode, { title: string; description: string; submit: string }> = {
  set: {
    title: "Set a password",
    description:
      "Sign in with your email and this password, as well as with the account you signed up with.",
    submit: "Set password",
  },
  change: {
    title: "Change password",
    description: "Enter your current password, then the new one. Other sessions are signed out.",
    submit: "Change password",
  },
};

function PasswordDialog({ mode, onClose }: { mode: PasswordMode; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<PasswordDraft>({ current: "", next: "", confirm: "" });
  const [problem, setProblem] = useState<{ field: PasswordField; message: string } | null>(null);
  const copy = DIALOG_COPY[mode];

  const save = useMutation({
    mutationFn: async () => {
      if (mode === "set") await setFirstPassword(draft.next);
      else await changePassword({ currentPassword: draft.current, newPassword: draft.next });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: accountKeys.list });
      toast.success(mode === "set" ? "Your password is set" : "Your password is changed", {
        description:
          mode === "set"
            ? "You can now sign in with your email and this password too."
            : "Use the new one next time you sign in.",
      });
      setOpen(false);
    },
  });

  const submit = () => {
    const found = passwordDraftProblem(mode, draft);
    setProblem(found);
    if (!found) save.mutate();
  };

  const field = (name: PasswordField, label: string, autoComplete: string) => {
    const id = `password-${name}`;
    const error = problem?.field === name ? problem.message : null;
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          type="password"
          autoComplete={autoComplete}
          required
          disabled={save.isPending}
          value={draft[name]}
          onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
          aria-invalid={error ? true : undefined}
        />
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!save.isPending}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {mode === "change" ? field("current", "Current password", "current-password") : null}
            {field("next", "New password", "new-password")}
            {field("confirm", "Confirm new password", "new-password")}
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
