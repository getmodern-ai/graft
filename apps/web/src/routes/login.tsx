import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthHeader } from "@/components/auth/auth-header";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_SIGNED_IN_PATH, safeRedirectPath } from "@/lib/safe-redirect";
import { sessionKeys, sessionQuery } from "@/lib/session-queries";

/**
 * The sign-in door. `redirect` is where the `_auth` guard sent the visitor from — a handoff URL,
 * typically (ADR 0006) — and is honoured only as a same-origin path (`safe-redirect.ts`).
 */
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirectPath(search.redirect);
    return redirect ? { redirect } : {};
  },
  /** A signed-in visitor is sent where they belong rather than parked on a form they do not need. */
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData({
      ...sessionQuery,
      revalidateIfStale: true,
    });
    if (session) throw redirect({ href: search.redirect ?? DEFAULT_SIGNED_IN_PATH });
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect: returnTo } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({ email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not sign in");
      return;
    }
    // The guard decides from `sessionQuery`; drop the signed-out entry before it reads again.
    queryClient.removeQueries({ queryKey: sessionKeys.current });
    await navigate({ href: returnTo ?? DEFAULT_SIGNED_IN_PATH });
  };

  return (
    // Cando's pre-auth frame (its `routes/login.tsx`): the header band, the large heading, the
    // card beneath. Without the strip of faces along the bottom, and so without the `md:pb-40`
    // that cleared it and the `overflow-hidden` that clipped it (ADR 0017).
    <div className="flex min-h-svh flex-col">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6">
        <h1 className="text-center text-4xl tracking-tight">Sign in to Graft</h1>
        <AuthCard className="mt-9 md:mt-8">
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="email" className="leading-none">
                  Email
                </FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={pending}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password" className="leading-none">
                  Password
                </FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                />
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
            </FieldGroup>

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>

            <p className="text-center text-muted-foreground text-sm">
              New to Graft?{" "}
              <Link
                to="/signup"
                search={{ redirect: returnTo }}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                Create an account
              </Link>
            </p>
          </form>
        </AuthCard>
      </main>
    </div>
  );
}
