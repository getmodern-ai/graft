import type { SocialProviderName } from "@graft/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { SettingsEmptyRow, SettingsRow } from "@/components/settings/settings-row";
import { StatusChip } from "@/components/status-chip";
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
import { linkProvider, unlinkProvider, updateName } from "@/lib/account-queries";
import { MAX_NAME_LENGTH, nameDraftProblem, socialRows } from "@/lib/account-settings";
import { authClient } from "@/lib/auth-client";
import { accountKeys, accountsQuery } from "@/lib/password-queries";
import { sessionKeys } from "@/lib/session-queries";
import { SOCIAL_PROVIDER_LABELS, signInMethodsQuery } from "@/lib/sign-in";
import { EMAIL_STATUS_CHIP, SIGN_IN_ACCOUNT_CHIP } from "@/lib/status-chips";

/**
 * Settings › Account's rows above the password (GRA-331; Figma 2100:10414): the name, the address,
 * and a row per provider the server names. Each is a direct child of the caller's
 * `SettingsRowGroup`, so the group's inset dividers fall between them; a dialog rides beside its
 * row in a fragment, which renders into a portal and takes no divider.
 */

function RowSkeleton() {
  return (
    <SettingsEmptyRow>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-7 w-24" />
    </SettingsEmptyRow>
  );
}

/** The session the guard already holds; pending only on a cold reload, and then briefly. */
export function NameRow() {
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  if (isPending || !session) return <RowSkeleton />;
  return (
    <>
      <SettingsRow
        title="Name"
        description="How Graft greets you."
        action={
          <div className="flex items-center gap-2">
            <span className="max-w-60 truncate text-sm">{session.user.name}</span>
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              Edit
            </Button>
          </div>
        }
      />
      {open ? <NameDialog initial={session.user.name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Mounted per opening, as the password dialog is, so a draft never outlives its dialog. */
function NameDialog({ initial, onClose }: { initial: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => updateName(draft),
    onSuccess: async () => {
      // The guard's cached read carries the name too (`session-queries.ts`).
      await queryClient.invalidateQueries({ queryKey: sessionKeys.current });
      toast.success("Your name is saved");
      setOpen(false);
    },
  });

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
            const found = nameDraftProblem(draft);
            setProblem(found);
            if (!found) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit your name</DialogTitle>
            <DialogDescription>Graft greets you by it on Home and in the menu.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-name">Name</FieldLabel>
              <Input
                id="account-name"
                autoComplete="name"
                maxLength={MAX_NAME_LENGTH + 20}
                disabled={save.isPending}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-invalid={problem ? true : undefined}
              />
              {problem ? <FieldError>{problem}</FieldError> : null}
            </Field>
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
              {save.isPending ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EmailRow() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending || !session) return <RowSkeleton />;
  return (
    <SettingsRow
      title="Email"
      description="Where Graft sends sign-in and password emails."
      action={
        <div className="flex items-center gap-2">
          <span className="max-w-60 truncate text-sm">{session.user.email}</span>
          <StatusChip
            chip={EMAIL_STATUS_CHIP[session.user.emailVerified ? "verified" : "unverified"]}
          />
        </div>
      }
    />
  );
}

/**
 * A row per provider `GET /api/sign-in-methods` names, none for one it does not (ADR 0020), so a
 * self-host with neither draws nothing here. The rows wait on the accounts read the password row
 * shares; its failure is shown once, by the password row, rather than once per provider. Removing
 * the last way of signing in is never offered (`account-settings.ts`'s `canDisconnect`).
 */
export function SocialAccountRows() {
  const methods = useQuery(signInMethodsQuery);
  const accounts = useQuery(accountsQuery);
  const [disconnecting, setDisconnecting] = useState<{
    provider: SocialProviderName;
    accountId: string;
  } | null>(null);

  const configured = methods.data?.social ?? [];
  if (methods.isPending) return <RowSkeleton />;
  if (configured.length === 0) return null;
  if (accounts.data === undefined) {
    return accounts.isError ? null : configured.map((provider) => <RowSkeleton key={provider} />);
  }

  return (
    <>
      {socialRows(accounts.data, configured).map((row) => {
        const label = SOCIAL_PROVIDER_LABELS[row.provider];
        const { accountId } = row;
        return (
          <SettingsRow
            key={row.provider}
            title={label}
            description={
              accountId && !row.canDisconnect
                ? `Your only way to sign in. Set a password or connect another account to disconnect ${label}.`
                : `Sign in with your ${label} account.`
            }
            action={
              accountId ? (
                <div className="flex items-center gap-2">
                  <StatusChip chip={SIGN_IN_ACCOUNT_CHIP} />
                  {row.canDisconnect ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDisconnecting({ provider: row.provider, accountId })}
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              ) : (
                <ConnectButton provider={row.provider} />
              )
            }
          />
        );
      })}
      {disconnecting ? (
        <DisconnectDialog
          {...disconnecting}
          onClose={() => setDisconnecting(null)}
          key={disconnecting.accountId}
        />
      ) : null}
    </>
  );
}

/**
 * The page leaves for the provider on success, so the label stays at its pending form until it
 * does; a refusal before the redirect comes back to the button through the mutation cache's toast.
 */
function ConnectButton({ provider }: { provider: SocialProviderName }) {
  const link = useMutation({ mutationFn: () => linkProvider(provider) });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={link.isPending || link.isSuccess}
      onClick={() => link.mutate()}
    >
      {link.isPending || link.isSuccess ? "Connecting…" : "Connect"}
    </Button>
  );
}

/**
 * The revoke dialog's shape (`components/agent/revoke-agent-dialog.tsx`): Cancel first, the
 * destructive action last, close requests ignored while the removal is in flight.
 */
function DisconnectDialog({
  provider,
  accountId,
  onClose,
}: {
  provider: SocialProviderName;
  accountId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const label = SOCIAL_PROVIDER_LABELS[provider];
  const unlink = useMutation({
    mutationFn: () => unlinkProvider({ provider, accountId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: accountKeys.list });
      toast.success(`${label} is disconnected`);
      setOpen(false);
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next || !unlink.isPending) setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            You will no longer sign in to Graft with this {label} account. Your agents, integrations
            and tools are not affected, and you can connect {label} again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={unlink.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={unlink.isPending}
            onClick={() => unlink.mutate()}
          >
            {unlink.isPending ? "Disconnecting…" : "Disconnect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
