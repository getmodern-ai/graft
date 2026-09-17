import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthHeader } from "@/components/auth/auth-header";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

/**
 * Where "Forgot password?" leads — Cando's `routes/forgot-password.tsx` (its CAN-166), GRA-82.
 * Pre-auth on purpose, beside `/login`: the whole audience of this screen is people who cannot
 * sign in.
 *
 * One rule owns the screen: **the answer is identical whether or not an account exists.** The
 * confirmation below renders whatever the request returned — success, unknown address, even a
 * network failure — because any visible difference would let this form probe which addresses
 * have accounts, the same enumeration stance the one door already takes. Better Auth upholds the
 * mail half itself: no email is sent for an unknown address, and a send failure is logged
 * server-side, never surfaced (`sendResetPassword` in `packages/auth`).
 */
export const Route = createFileRoute("/forgot-password")({
  validateSearch: (search: Record<string, unknown>): { email?: string } => {
    /** Prefilled by the door's link, so the address survives the hop. */
    const email = typeof search.email === "string" && search.email ? search.email : undefined;
    return email ? { email } : {};
  },
  component: ForgotPasswordRoute,
});

function ForgotPasswordRoute() {
  const search = Route.useSearch();
  const [email, setEmail] = useState(search.email ?? "");
  const [pending, setPending] = useState(false);
  /** The address the confirmation names — frozen at submit, so edits after cannot confuse it. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);

    /**
     * The outcome is deliberately not consulted. Success and failure land on the same
     * confirmation; the catch exists only because a dropped connection throws rather than
     * returning an error shape.
     */
    try {
      await authClient.requestPasswordReset({ email });
    } catch {
      // Same confirmation regardless — see the route comment.
    }

    setSentTo(email);
    setPending(false);
  };

  return (
    // The same pre-auth frame as `/login` — this screen is that screen's sibling, and should
    // read as one.
    <div className="flex min-h-svh flex-col">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6">
        <h1 className="text-center text-4xl tracking-tight">Reset your password</h1>

        <AuthCard className="mt-9 md:mt-8">
          {sentTo ? (
            <div className="flex flex-col gap-6">
              <p className="text-balance text-sm">
                If an account exists for {sentTo}, we've sent a reset link. Check your inbox.
              </p>
              <Button
                nativeButton={false}
                variant="outline"
                className="w-full"
                render={<Link to="/login" />}
              >
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="forgot-password-email" className="leading-none">
                    Email
                  </FieldLabel>
                  <Input
                    id="forgot-password-email"
                    name="email"
                    type="email"
                    placeholder="m@example.com"
                    autoComplete="email"
                    required
                    // The visitor arrived to type exactly this field.
                    autoFocus
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={pending}
                  />
                </Field>
              </FieldGroup>

              <Button type="submit" className="w-full" disabled={pending}>
                Send reset link
              </Button>

              <p className="text-center text-muted-foreground text-sm">
                Remembered it?{" "}
                <Link to="/login" className="underline underline-offset-4 hover:text-foreground">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </AuthCard>
      </main>
    </div>
  );
}
