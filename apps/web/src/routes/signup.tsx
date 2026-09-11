import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthHeader } from "@/components/auth/auth-header";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_SIGNED_IN_PATH, safeRedirectPath } from "@/lib/safe-redirect";
import { sessionKeys, sessionQuery } from "@/lib/session-queries";

/**
 * The sign-up door. Verification is off for the alpha — the reason is on the option in
 * `packages/auth/src/index.ts` — so an account opens a session at once and lands in the console.
 * Its own route rather than a step on `/login`, as in Cando (its `routes/signup.tsx`).
 */
export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirectPath(search.redirect);
    return redirect ? { redirect } : {};
  },
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData({
      ...sessionQuery,
      revalidateIfStale: true,
    });
    if (session) throw redirect({ href: search.redirect ?? DEFAULT_SIGNED_IN_PATH });
  },
  component: SignupRoute,
});

function SignupRoute() {
  const { redirect: returnTo } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.signUp.email({ name, email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not create the account");
      return;
    }
    queryClient.removeQueries({ queryKey: sessionKeys.current });
    await navigate({ href: returnTo ?? DEFAULT_SIGNED_IN_PATH });
  };

  return (
    // The same pre-auth frame as `/login` — this screen is that screen's sibling, and should
    // read as one.
    <div className="flex min-h-svh flex-col">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6">
        <h1 className="text-center text-4xl tracking-tight">Welcome to Graft</h1>
        <AuthCard className="mt-9 md:mt-8">
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="name" className="leading-none">
                  Name
                </FieldLabel>
                <Input
                  id="name"
                  name="name"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={pending}
                />
              </Field>
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
                  // `new-password`, so password managers offer to generate one instead of filling
                  // a stored one into a registration.
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                />
                <FieldDescription>At least eight characters.</FieldDescription>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
            </FieldGroup>

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Creating…" : "Create account"}
            </Button>

            <p className="text-center text-muted-foreground text-sm">
              Already have one?{" "}
              <Link
                to="/login"
                search={{ redirect: returnTo }}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                Sign in
              </Link>
            </p>
          </form>
        </AuthCard>
      </main>
    </div>
  );
}
