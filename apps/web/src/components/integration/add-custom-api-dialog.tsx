import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";
import type { ConnectAccess } from "@graft/server/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ConnectionFormFields } from "@/components/connection/connection-form";
import { CredentialFields } from "@/components/connection/credential-fields";
import { ConsentStatus, OAuthClientNotice } from "@/components/connection/oauth-client-notice";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import {
  CheckCircleIcon,
  ErrorIcon,
  KeyboardArrowDownIcon,
  KeyboardArrowUpIcon,
  LockIcon,
  OpenInNewIcon,
  ProgressActivityIcon,
  StarsIcon,
  WarningIcon,
} from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { SetupChoice } from "@/components/setup/setup-choice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { agentKeys } from "@/lib/agent-queries";
import { ApiError } from "@/lib/api";
import { approvalKeys } from "@/lib/approval-queries";
import {
  type ConnectionDraft,
  type ConnectionRegistration,
  type DraftErrors,
  hostsOf,
  secretLegend,
  validateConnectionDraft,
  validateCredentialDraft,
} from "@/lib/connection-form";
import { connectionKeys, fetchConnection } from "@/lib/connection-queries";
import {
  checklistProgress,
  connectBodyOf,
  connectedToast,
  draftByHand,
  draftFromFailure,
  draftFromProposalState,
  failureOpensForm,
  isLostProposal,
  type NameStepErrors,
  type NameStepInput,
  onlySentToLine,
  type ProposalState,
  proposalChecklist,
  proposalSummary,
  readStartRefusal,
  usableDocsUrl,
  validateNameStep,
} from "@/lib/custom-api";
import {
  connectFromConsole,
  createConnectionWithAccess,
  proposalAvailabilityQuery,
  proposalQuery,
  startProposal,
} from "@/lib/custom-api-queries";
import { accessOptions } from "@/lib/integrations-discover";
import { openConsentPopup } from "@/lib/oauth-consent";
import { awaitLink, type LinkSettled } from "@/lib/provider-link";
import { providerLabel } from "@/lib/provider-name";
import { cn } from "@/lib/utils";

/**
 * *Add a custom API* (GRA-323; Figma 2120:15303, 2120:15596, 2121:15654, 2121:16111), Flow C: an
 * integration the directory does not have, connected from its API docs with no agent asking (ADR
 * 0006 as amended 2026-10-14). Three steps in one dialog: name it and link its docs; Graft works it
 * out (GRA-299's job, polled, as a four-line checklist); check what Graft found, add the key and
 * choose the access (ADR 0008 as amended 2026-10-14), then connect through GRA-304's
 * `POST /api/connect` and, for the keyring's form, `POST /api/connections` with the same access. A
 * connection lands on its integration's page with a toast.
 *
 * The key is entered here and nowhere else (ADR 0004): the job reads docs and never asks for one.
 * Where no model is configured, or the person would rather type it, the same check step opens as
 * the plain form; a refused proposal (`host_not_public`) opens it with the sentence above.
 *
 * `initialName` and `initialDocsUrl` prefill the name step, for Discover's *Add it yourself*
 * (GRA-322) and anything else that knows what the person searched for.
 */
export function AddCustomApiDialog({
  open,
  onOpenChange,
  initialName,
  initialDocsUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  initialDocsUrl?: string;
}) {
  // A connect in flight holds the dialog open, as a destructive confirmation does while pending.
  const busy = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else if (!busy.current) onOpenChange(false);
      }}
    >
      {open ? (
        <CustomApiFlow
          initial={{ name: initialName ?? "", docsUrl: initialDocsUrl ?? "" }}
          close={() => onOpenChange(false)}
          busy={busy}
        />
      ) : null}
    </Dialog>
  );
}

const UNCONFIGURED_TITLE = "Graft can't read API docs here";

/** Where the dialog stands. The check step carries the form it opens with. */
type Phase =
  | { step: "name"; error: string | null }
  | { step: "working"; jobId: string }
  | { step: "failed"; state: ProposalState }
  | { step: "lost" }
  | { step: "check"; check: CheckSetup };

type CheckSetup = {
  /** Bumped per check step, so a second opening starts from its own draft. */
  key: string;
  draft: ConnectionDraft;
  errors: DraftErrors;
  docsUrl: string | null;
  docsHost: string | null;
  /** `refused` for a proposal the rules turned down; `info` for the deployment's own state. */
  notice: { title: string; message: string; tone: "info" | "refused" } | null;
  unresolvedHosts: string[];
  /** Graft's proposal folds the details behind its summary; the plain form shows them. */
  found: boolean;
};

function CustomApiFlow({
  initial,
  close,
  busy,
}: {
  initial: NameStepInput;
  close: () => void;
  busy: React.MutableRefObject<boolean>;
}) {
  const availability = useQuery(proposalAvailabilityQuery);
  const [input, setInput] = useState<NameStepInput>(initial);
  const [phase, setPhase] = useState<Phase>({ step: "name", error: null });
  const unconfigured =
    availability.data && !availability.data.available ? availability.data.message : null;

  const handSetup = (notice: CheckSetup["notice"]): CheckSetup => ({
    key: `hand-${Date.now()}`,
    draft: draftByHand(input),
    errors: {},
    docsUrl: usableDocsUrl(input.docsUrl),
    docsHost: null,
    notice,
    unresolvedHosts: [],
    found: false,
  });
  const byHand = (notice: CheckSetup["notice"]): Phase => ({
    step: "check",
    check: handSetup(notice),
  });

  // No model reads docs here: the plain form is the flow (the ticket's unavailable state).
  if (unconfigured && phase.step === "name") {
    return (
      <CheckStep
        key="unconfigured"
        setup={handSetup({ title: UNCONFIGURED_TITLE, message: unconfigured, tone: "info" })}
        close={close}
        busy={busy}
      />
    );
  }

  switch (phase.step) {
    case "name":
      return (
        <NameStep
          input={input}
          onInput={setInput}
          error={phase.error}
          onStarted={(jobId) => setPhase({ step: "working", jobId })}
          onRefused={(message) => setPhase({ step: "name", error: message })}
          onUnconfigured={(message) =>
            setPhase(byHand({ title: UNCONFIGURED_TITLE, message, tone: "info" }))
          }
          onByHand={() => setPhase(byHand(null))}
          close={close}
        />
      );
    case "working":
      return (
        <WorkingStep
          jobId={phase.jobId}
          name={input.name.trim()}
          onSettled={(state) => {
            if (state.status === "ready") {
              const draft = draftFromProposalState(state);
              if (draft) {
                setPhase({
                  step: "check",
                  check: {
                    key: state.id,
                    draft,
                    errors: {},
                    docsUrl: state.docsUrl,
                    docsHost: state.found.docsHost,
                    notice: null,
                    unresolvedHosts: state.unresolvedHosts,
                    found: true,
                  },
                });
                return;
              }
            }
            if (state.failure && failureOpensForm(state.failure.reason)) {
              const { draft, errors } = draftFromFailure(state);
              setPhase({
                step: "check",
                check: {
                  key: state.id,
                  draft,
                  errors,
                  docsUrl: state.docsUrl,
                  docsHost: state.found.docsHost,
                  notice: {
                    title: "Graft could not use what it found",
                    // The refusal's own sentence is under the input it is about.
                    message: "Fix what is marked below, then add your key.",
                    tone: "refused",
                  },
                  unresolvedHosts: [],
                  found: false,
                },
              });
              return;
            }
            setPhase({ step: "failed", state });
          }}
          onLost={() => setPhase({ step: "lost" })}
          close={close}
        />
      );
    case "failed":
    case "lost":
      return (
        <FailedStep
          name={input.name.trim()}
          message={
            phase.step === "failed"
              ? (phase.state.failure?.message ?? "Graft could not work out the connection.")
              : "Graft lost track of this one, most likely because it restarted. Start again."
          }
          onRetry={() => setPhase({ step: "name", error: null })}
          onByHand={() =>
            setPhase(
              phase.step === "failed"
                ? {
                    step: "check",
                    check: {
                      ...draftFromFailure(phase.state),
                      key: `hand-${phase.state.id}`,
                      docsUrl: phase.state.docsUrl,
                      docsHost: phase.state.found.docsHost,
                      notice: null,
                      unresolvedHosts: [],
                      found: false,
                    },
                  }
                : byHand(null),
            )
          }
          close={close}
        />
      );
    case "check":
      return <CheckStep key={phase.check.key} setup={phase.check} close={close} busy={busy} />;
  }
}

/** Step 1 (Figma 2120:15303): the integration's name and a link to its API docs, both required. */
function NameStep({
  input,
  onInput,
  error,
  onStarted,
  onRefused,
  onUnconfigured,
  onByHand,
  close,
}: {
  input: NameStepInput;
  onInput: (next: NameStepInput) => void;
  error: string | null;
  onStarted: (jobId: string) => void;
  onRefused: (message: string) => void;
  onUnconfigured: (message: string) => void;
  onByHand: () => void;
  close: () => void;
}) {
  const [errors, setErrors] = useState<NameStepErrors>({});
  const [starting, setStarting] = useState(false);

  // Not a `useMutation`: every refusal here is drawn in the dialog, and one of them (a job of the
  // person's still running) is followed rather than shown, so the global mutation toast would lie.
  const submit = async () => {
    const problems = validateNameStep(input);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setStarting(true);
    try {
      const started = await startProposal({
        name: input.name.trim(),
        docsUrl: input.docsUrl.trim(),
      });
      onStarted(started.id);
    } catch (caught) {
      const refusal = readStartRefusal(caught);
      if (refusal.kind === "running") onStarted(refusal.id);
      else if (refusal.kind === "unconfigured") onUnconfigured(refusal.message);
      else if (refusal.kind === "field") setErrors({ [refusal.field]: refusal.message });
      else onRefused(refusal.message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-md">
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add a custom API</DialogTitle>
          <DialogDescription>
            Tell Graft which integration. It reads the docs and works out how to connect.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <ErrorIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <FieldGroup>
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="custom-api-name">Integration name</FieldLabel>
            <Input
              id="custom-api-name"
              value={input.name}
              disabled={starting}
              placeholder="Name it as you call it"
              autoComplete="off"
              autoFocus={input.name === ""}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => onInput({ ...input, name: event.target.value })}
            />
            {errors.name ? <FieldError>{errors.name}</FieldError> : null}
          </Field>
          <Field data-invalid={errors.docsUrl ? true : undefined}>
            <FieldLabel htmlFor="custom-api-docs">Link to its API docs</FieldLabel>
            <Input
              id="custom-api-docs"
              value={input.docsUrl}
              disabled={starting}
              placeholder="Paste the docs page's link"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              autoFocus={input.name !== ""}
              aria-invalid={errors.docsUrl ? true : undefined}
              onChange={(event) => onInput({ ...input, docsUrl: event.target.value })}
            />
            <FieldDescription>
              The page on how its API signs in works best, for example
              https://apidocs.example.com/authentication.
            </FieldDescription>
            {errors.docsUrl ? <FieldError>{errors.docsUrl}</FieldError> : null}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="sm:mr-auto"
            disabled={starting}
            onClick={onByHand}
          >
            Set it up by hand
          </Button>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={starting}>
            <StarsIcon />
            {starting ? "Starting…" : "Create integration"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Step 2 (Figma 2120:15596): the job's four stages as a checklist, read every second until it
 * settles. Cancel stops reading; the job settles on its own and frees the person to start again.
 */
function WorkingStep({
  jobId,
  name,
  onSettled,
  onLost,
  close,
}: {
  jobId: string;
  name: string;
  onSettled: (state: ProposalState) => void;
  onLost: () => void;
  close: () => void;
}) {
  const job = useQuery(proposalQuery(jobId));
  const state = job.data;
  const settled = state && state.status !== "running" ? state : null;
  // Only a 404 means the job is gone; any other failed read is offered again on the same job.
  const lost = isLostProposal(job.error);
  const unreachable = job.isError && !lost;

  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;
  useEffect(() => {
    if (settled) onSettledRef.current(settled);
  }, [settled]);
  useEffect(() => {
    if (lost) onLostRef.current();
  }, [lost]);

  const lines = state ? proposalChecklist(state) : null;
  const shownName = state?.name ?? name;

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Setting up {shownName}</DialogTitle>
        <DialogDescription>
          Graft is reading the docs. This usually takes under a minute.
        </DialogDescription>
      </DialogHeader>
      <ol className="flex flex-col gap-3" aria-live="polite">
        {(lines ?? []).map((line) => (
          <li key={line.stage} className="flex items-start gap-2.5">
            <ChecklistIcon status={line.status} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                className={cn(
                  "font-medium",
                  line.status === "pending" ? "text-muted-foreground" : null,
                )}
              >
                {line.label}
              </span>
              {line.detail ? (
                <span className="truncate text-muted-foreground text-xs">{line.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {unreachable ? (
        <RetryNotice
          error={job.error}
          message="Could not check on Graft's progress."
          onRetry={() => void job.refetch()}
          retrying={job.isFetching}
        />
      ) : null}
      <div
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={lines ? checklistProgress(lines) : 0}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${lines ? checklistProgress(lines) : 5}%` }}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ChecklistIcon({
  status,
}: {
  status: ReturnType<typeof proposalChecklist>[number]["status"];
}) {
  const className = "mt-0.5 size-4 shrink-0";
  switch (status) {
    case "done":
      return <CheckCircleIcon aria-label="Done" className={cn(className, "text-success")} />;
    case "active":
      return (
        <ProgressActivityIcon
          aria-label="In progress"
          className={cn(className, "animate-spin text-primary")}
        />
      );
    case "failed":
      return <ErrorIcon aria-label="Stopped" className={cn(className, "text-destructive")} />;
    case "pending":
      return (
        <span
          role="img"
          aria-label="Not started"
          className={cn(className, "rounded-full border border-muted-foreground/40 border-dashed")}
        />
      );
  }
}

/** A job that ended with nothing to put on the form: its sentence, Try again, or by hand. */
function FailedStep({
  name,
  message,
  onRetry,
  onByHand,
  close,
}: {
  name: string;
  message: string;
  onRetry: () => void;
  onByHand: () => void;
  close: () => void;
}) {
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Couldn't set up {name || "the integration"}</DialogTitle>
        <DialogDescription>{message}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="ghost" className="sm:mr-auto" onClick={close}>
          Cancel
        </Button>
        <Button type="button" variant="outline" onClick={onByHand}>
          Set it up by hand
        </Button>
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

type Connected = { vendor: string; displayName: string };

/**
 * Step 3 (Figma 2121:15654): the key, where it goes, what the agents may do, and Graft's proposal
 * folded under its summary, editable: the same fields as an agent's proposal
 * (`ConnectionFormFields`), the secret from the scheme's table (`CredentialFields`).
 */
function CheckStep({
  setup,
  close,
  busy,
}: {
  setup: CheckSetup;
  close: () => void;
  busy: React.MutableRefObject<boolean>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ConnectionDraft>(setup.draft);
  const [errors, setErrors] = useState<DraftErrors>(setup.errors);
  const [access, setAccess] = useState<ConnectAccess>("full");
  const [details, setDetails] = useState(!setup.found || Object.keys(setup.errors).length > 0);
  const [linkWait, setLinkWait] = useState<{ provider: string; stop: AbortController } | null>(
    null,
  );

  // Closing or leaving the dialog ends every wait it started (a consent popup, a provider's
  // sign-in), so an old popup finishing later cannot close a reopened dialog or navigate away.
  const alive = useRef(true);
  const stopLink = useRef<AbortController | null>(null);
  const finished = ({ vendor, displayName }: Connected) => {
    queryClient.invalidateQueries({ queryKey: connectionKeys.all });
    queryClient.invalidateQueries({ queryKey: agentKeys.all });
    queryClient.invalidateQueries({ queryKey: approvalKeys.builds });
    busy.current = false;
    if (!alive.current) return;
    const copy = connectedToast(displayName, access);
    toast.success(copy.title, { description: copy.description });
    // Leaving the screen closes the dialog. Closing it first would let a caller that keeps the
    // dialog in the URL (Discover's `custom`) navigate back over this.
    void navigate({ to: "/integrations/$vendor", params: { vendor } });
  };
  const consent = useOAuthConsent({
    onConnected: () => finished({ vendor: draft.vendor.trim(), displayName: draft.displayName }),
  });
  const cancelConsent = useRef(consent.cancel);
  cancelConsent.current = consent.cancel;
  useEffect(() => {
    // Set on mount as well: StrictMode runs this cleanup once before the real mount.
    alive.current = true;
    return () => {
      alive.current = false;
      busy.current = false;
      cancelConsent.current();
      stopLink.current?.abort();
    };
  }, [busy]);

  const connect = useMutation({
    mutationFn: async ({
      registration,
      credential,
    }: {
      registration: ConnectionRegistration;
      credential: Record<string, string>;
    }) => {
      const routed = await connectFromConsole(connectBodyOf(registration, setup.docsUrl, access));
      if (routed.kind !== "form") return { routed, stored: null, credentialErrors: null };
      // The key is asked for only now: a provider that connects without it never needs one.
      const key = validateCredentialDraft(registration.scheme, credential);
      if (!key.ok) return { routed, stored: null, credentialErrors: key.errors };
      const stored = await createConnectionWithAccess({
        ...registration,
        credential: key.value,
        access,
      });
      return { routed, stored, credentialErrors: null };
    },
    onMutate: () => {
      busy.current = true;
    },
    onSuccess: async ({ routed, stored, credentialErrors }, { registration }) => {
      if (credentialErrors) {
        busy.current = false;
        setErrors(credentialErrors);
        return;
      }
      if (routed.kind === "connected") {
        finished(routed.connection);
        return;
      }
      if (routed.kind === "form" && stored) {
        queryClient.invalidateQueries({ queryKey: connectionKeys.all });
        if (stored.authorizeUrl) {
          busy.current = false;
          void consent.run(stored.authorizeUrl, stored.connection);
          return;
        }
        finished(stored.connection);
        return;
      }
      if (routed.kind === "link") {
        // A link provider covers these hosts (ADR 0019): the person signs in there instead of
        // pasting a key, and the connection is made under the link's id once they return.
        const popup = openConsentPopup(routed.url);
        if (!popup) {
          busy.current = false;
          toast.error("Your browser blocked the sign-in window. Allow popups, then Connect again.");
          return;
        }
        const stop = new AbortController();
        stopLink.current = stop;
        setLinkWait({ provider: routed.provider, stop });
        // `/link/callback`'s message names the record (GRA-304), so a failed sign-in ends the
        // wait at once; the poll is the fallback, the row being made under the record's id.
        const { outcome, message } = await awaitLink({
          popup,
          match: { connectId: routed.connectId },
          isSettled: () =>
            fetchConnection(routed.connectId).then(
              ({ connection }): LinkSettled =>
                connection.revokedAt === null
                  ? { settled: true, connectionId: connection.id }
                  : { settled: false },
              (): LinkSettled => ({ settled: false }),
            ),
          signal: stop.signal,
          deadlineMs: Math.max(0, new Date(routed.expiresAt).getTime() - Date.now()),
        });
        stopLink.current = null;
        busy.current = false;
        if (!alive.current) return;
        setLinkWait(null);
        if (outcome === "connected") finished(registration);
        else if (outcome === "expired") toast.error("The sign-in took too long. Connect again.");
        else if (outcome !== "stopped") {
          toast.error(message || "Nothing was connected. Connect again to try once more.");
        }
      }
    },
    onError: (error) => {
      busy.current = false;
      // A refused host lands under the input it is about, the editor opened (ADR 0010).
      if (error instanceof ApiError && error.status === 400) {
        const reason = (error.details as { reason?: string; host?: string } | undefined)?.reason;
        if (reason === "host_not_public") {
          const host = (error.details as { host?: string }).host ?? "";
          let primary: string | null = null;
          try {
            primary = new URL(draft.primaryHost.trim()).hostname;
          } catch {
            primary = null;
          }
          setErrors({ [host && primary !== host ? "hosts" : "primaryHost"]: error.message });
          setDetails(true);
        }
      }
    },
  });

  // The registration is judged here; the key only once `/connect` says the keyring's form takes it.
  const submit = () => {
    const verdict = validateConnectionDraft(draft, { withCredential: false });
    if (!verdict.ok) {
      setErrors(verdict.errors);
      setDetails(true);
      return;
    }
    setErrors({});
    const { credential: _unchecked, ...registration } = verdict.value;
    connect.mutate({ registration, credential: draft.credential });
  };

  const name = draft.displayName.trim() || "the integration";
  const integrationName = integrationNameFor(draft.vendor.trim(), draft.displayName.trim());
  const secret = secretLegend(draft);
  const consenting = consent.state.phase === "running" || consent.state.phase === "blocked";
  const pending = connect.isPending || consenting || linkWait !== null;
  const editorErrors = Object.keys(errors).some((key) => !key.startsWith("credential"));

  return (
    <DialogContent className="sm:max-w-xl" showCloseButton={false}>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogHeader className="items-center text-center">
          <IntegrationMark
            slug={draft.vendor.trim() || null}
            name={draft.displayName}
            tile="outline"
            tileSize={40}
          />
          <DialogTitle className="text-base">Connect {name}?</DialogTitle>
          <DialogDescription>
            {setup.found && setup.docsHost
              ? `Graft read the API docs at ${setup.docsHost} and set this up. Check it, then add your key.`
              : "Fill in how it connects, then add your key."}
          </DialogDescription>
        </DialogHeader>

        {setup.notice ? (
          <Alert variant={setup.notice.tone === "refused" ? "destructive" : "default"}>
            <WarningIcon />
            <AlertTitle>{setup.notice.title}</AlertTitle>
            <AlertDescription>{setup.notice.message}</AlertDescription>
          </Alert>
        ) : null}

        {secret ? (
          <FieldGroup>
            <CredentialFields
              scheme={draft.scheme}
              value={draft.credential}
              onChange={(credential) => setDraft({ ...draft, credential })}
              errors={errors}
              idPrefix="custom-api"
              disabled={pending}
              autoFocus={!editorErrors}
            />
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <LockIcon className="mt-px size-3.5 shrink-0" />
              {onlySentToLine(hostsOf(draft))}
            </p>
          </FieldGroup>
        ) : (
          <CredentialFields
            scheme={draft.scheme}
            value={draft.credential}
            onChange={(credential) => setDraft({ ...draft, credential })}
            errors={errors}
            idPrefix="custom-api"
          />
        )}

        {setup.unresolvedHosts.length > 0 ? (
          <Alert role="note">
            <WarningIcon />
            <AlertTitle>Check the address</AlertTitle>
            <AlertDescription>
              {setup.unresolvedHosts.join(", ")} did not answer when Graft looked it up. Fix it
              below if it is wrong.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          {/* The group's own legend is for a screen reader; this is the same words, drawn. */}
          <p className="font-medium text-sm" aria-hidden="true">
            What can your agents do with it?
          </p>
          <SetupChoice<ConnectAccess>
            name="custom-api-access"
            legend="What can your agents do with it?"
            className="gap-2 sm:grid-cols-1 lg:grid-cols-1"
            options={accessOptions(integrationName).map((option) => ({
              value: option.value,
              label: option.label,
              description: option.description,
              // Full access is the frame's recommendation (Figma 2121:15654).
              aside:
                option.value === "full" ? (
                  <Badge variant="secondary">Recommended</Badge>
                ) : undefined,
            }))}
            value={access}
            onChange={setAccess}
            disabled={pending}
          />
        </div>

        <OAuthClientNotice draft={draft} />

        <div className="flex flex-col gap-3 border-t pt-3">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-muted-foreground text-xs">
              {proposalSummary(draft, setup.found ? setup.docsHost : null)}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mt-1 shrink-0"
              aria-expanded={details || editorErrors}
              onClick={() => setDetails((open) => !open)}
            >
              {details || editorErrors ? "Hide details" : "Show details"}
              {details || editorErrors ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
            </Button>
          </div>
          {details || editorErrors ? (
            <div className="flex flex-col gap-4 rounded-lg bg-muted/50 p-3">
              {setup.docsUrl ? (
                <p className="flex items-start justify-between gap-2 text-muted-foreground text-xs">
                  <span>
                    {setup.found
                      ? `Graft read ${setup.docsHost ?? "the docs"}. Fix anything that looks wrong.`
                      : "Fill in what the docs say."}
                  </span>
                  <a
                    href={setup.docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="shrink-0 hover:text-foreground"
                    aria-label="Open the API docs"
                  >
                    <OpenInNewIcon className="size-3.5" />
                  </a>
                </p>
              ) : null}
              <FieldGroup>
                <ConnectionFormFields
                  draft={draft}
                  onChange={setDraft}
                  errors={errors}
                  idPrefix="custom-api"
                  disabled={pending}
                />
              </FieldGroup>
            </div>
          ) : null}
        </div>

        <ConsentStatus state={consent.state} onCancel={consent.cancel} />
        {linkWait ? (
          <Alert role="status">
            <ProgressActivityIcon className="animate-spin" />
            <AlertTitle>Sign in to {name} in the window that opened</AlertTitle>
            <AlertDescription>
              It connects through {providerLabel(linkWait.provider)}, so the key above is not used.
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => linkWait.stop.abort()}
              >
                Stop waiting
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="sm:*:flex-1">
          <Button type="button" variant="outline" disabled={connect.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {connect.isPending || linkWait
              ? "Connecting…"
              : consenting
                ? "Waiting for the consent…"
                : consent.state.phase === "done" && consent.state.outcome !== "connected"
                  ? "Connect again"
                  : "Connect"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
