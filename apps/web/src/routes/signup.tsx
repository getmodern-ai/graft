import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_SIGNED_IN_PATH, safeRedirectPath } from "@/lib/safe-redirect";
import { sessionKeys, sessionQuery } from "@/lib/session-queries";

/**
 * The sign-up door. Verification is off for the alpha — the reason is on the option in
 * `packages/auth/src/index.ts` — so an account opens a session at once and lands in the console.
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
    <AuthCard
      title="Create an account"
      description="One account owns your connections and your toolbox, however many agents you run."
      footer={
        <span>
          Already have one?{" "}
          <Link
            to="/login"
            search={{ redirect: returnTo }}
            className="text-foreground underline underline-offset-4"
          >
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldDescription>At least eight characters.</FieldDescription>
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldGroup>
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Creating…" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
