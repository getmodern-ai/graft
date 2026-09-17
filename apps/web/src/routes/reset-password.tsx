import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthHeader } from "@/components/auth/auth-header";
import { ScheduleIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { deriveResetEntry, passwordPairIssue, performReset } from "@/lib/reset-password";

/**
 * Where the reset email's link lands — Cando's `routes/reset-password.tsx` (its CAN-166), GRA-82.
 * Pre-auth on purpose, beside `/login`: whoever is here cannot sign in, that being the point.
 *
 * The token rides in `?token=`, put there by `buildPasswordResetUrl` in `@graft/email`; `error`
 * is accepted too because Better Auth's own callback redirect reports a dead token that way, and
 * a link shaped like that deserves the honest answer rather than a crashed route. Whether the
 * token still *lives* is only ever the server's answer: `resetPassword` consumes it atomically,
 * and an expired or already-used one is refused as `INVALID_TOKEN` — which this screen turns
 * into the same dead state, with the request form as the way out.
 */
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    ...(typeof search.token === "string" ? { token: search.token } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  component: ResetPasswordRoute,
});

function ResetPasswordRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Flipped when the server refuses the token — the link died between email and submit. */
  const [refused, setRefused] = useState(false);

  const entry = deriveResetEntry(search);
  const dead = entry.kind === "dead" || refused;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || entry.kind !== "form") {
      return;
    }

    const issue = passwordPairIssue(password, confirm);
    if (issue) {
      setError(issue);
      return;
    }

    setPending(true);
    setError(null);

    /**
     * `performReset` is total — refusals, other errors and outright rejections all come back as
     * outcomes — so every path below runs and pending is always cleared. The one exception is
     * deliberate: `done` navigates away, and the form should stay disabled on the way out.
     */
    const outcome = await performReset(() =>
      authClient.resetPassword({ newPassword: password, token: entry.token }),
    );

    if (outcome.kind === "done") {
      toast.success("Password reset. Sign in with your new password.");
      await navigate({ to: "/login" });
      return;
    }

    if (outcome.kind === "refused") {
      setRefused(true);
    } else {
      setError(outcome.message);
    }
    setPending(false);
  };

  return (
    // The same pre-auth frame as `/login` — this screen is that screen's sibling, and should
    // read as one.
    <div className="flex min-h-svh flex-col">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6">
        {dead ? (
          // The screen-level empty, in Cando's voice: no frame of its own, a title without a
          // full stop, and a way out (GRA-47).
          <Empty className="mt-8 w-full max-w-md">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScheduleIcon />
              </EmptyMedia>
              <EmptyTitle className="text-balance">This reset link no longer works</EmptyTitle>
              <EmptyDescription className="text-balance">
                It may have expired or already been used — each link works once, for a short while.
                Request a new one and try again.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/forgot-password" />}>
                Request a new link
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <h1 className="text-center text-4xl tracking-tight">Choose a new password</h1>

            <AuthCard className="mt-9 md:mt-8">
              <form onSubmit={handleSubmit} className="flex flex-col gap-6">
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="reset-password-new" className="leading-none">
                      New password
                    </FieldLabel>
                    <Input
                      id="reset-password-new"
                      name="new-password"
                      type="password"
                      autoComplete="new-password"
                      required
                      // The visitor arrived to type exactly this field.
                      autoFocus
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={pending}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="reset-password-confirm" className="leading-none">
                      Confirm password
                    </FieldLabel>
                    <Input
                      id="reset-password-confirm"
                      name="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      required
                      value={confirm}
                      onChange={(event) => setConfirm(event.target.value)}
                      disabled={pending}
                    />
                  </Field>

                  {error && <FieldError>{error}</FieldError>}
                </FieldGroup>

                <Button type="submit" className="w-full" disabled={pending}>
                  Set new password
                </Button>
              </form>
            </AuthCard>
          </>
        )}
      </main>
    </div>
  );
}
