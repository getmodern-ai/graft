import type { SocialProviderName } from "@graft/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthHeader } from "@/components/auth/auth-header";
import { SignInCard, type SignInStep } from "@/components/auth/sign-in-card";
import { authClient } from "@/lib/auth-client";
import { emailAuthMessage } from "@/lib/email-auth-outcome";
import { DEFAULT_SIGNED_IN_PATH, safeRedirectPath } from "@/lib/safe-redirect";
import { sessionKeys, sessionQuery } from "@/lib/session-queries";
import { signInMethodsQuery, socialSignInMessage, socialSignInUrls } from "@/lib/sign-in";

/**
 * The one door — Cando's (its `routes/login.tsx`, CAN-64; GRA-81): sign-in and sign-up are the
 * same screen, the email is asked first and the password beneath it, and a provider button sits
 * under *Or*. `redirect` is where the `_auth` guard sent the visitor from — a handoff URL,
 * typically (ADR 0006) — and is honoured only as a same-origin path (`safe-redirect.ts`). `error`
 * is how a provider round trip that failed comes back here (`socialSignInUrls`), Better Auth's code,
 * read once into a sentence and never shown raw.
 */
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; error?: string } => {
    const redirect = safeRedirectPath(search.redirect);
    const error = typeof search.error === "string" && search.error ? search.error : undefined;
    return { ...(redirect ? { redirect } : {}), ...(error ? { error } : {}) };
  },
  /**
   * A signed-in visitor is sent where they belong rather than parked on a form they do not need;
   * a signed-out one has the provider list before the card paints, so the buttons never pop in.
   */
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData({
      ...sessionQuery,
      revalidateIfStale: true,
    });
    if (session) throw redirect({ href: search.redirect ?? DEFAULT_SIGNED_IN_PATH });
    await context.queryClient.ensureQueryData(signInMethodsQuery);
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect: returnTo, error: returnedError } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const methods = useQuery(signInMethodsQuery);
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => socialSignInMessage(returnedError));

  const goWhereTheyBelong = async () => {
    // The guard decides from `sessionQuery`; drop the signed-out entry before it reads again.
    queryClient.removeQueries({ queryKey: sessionKeys.current });
    await navigate({ href: returnTo ?? DEFAULT_SIGNED_IN_PATH });
  };

  /**
   * One door, so this has to both sign people in and register the ones the product has never
   * seen. Sign-in is attempted first and registration only on its failure — the reverse would
   * mean every returning person pays for a doomed write before getting in.
   *
   * The two cannot be told apart beforehand: Better Auth answers "no such account" and "wrong
   * password" identically on purpose, because distinguishing them is account enumeration
   * (`email-auth-outcome.ts` decides the message).
   *
   * The name is the address's local part, as in Cando. Cando's onboarding asks for the real one
   * before anything displays it; Graft shows it in the account menu and has no step that asks, so
   * a person who signs up with a password wears that placeholder until a settings row exists.
   */
  const continueWithEmail = async (password: string) => {
    setPending(true);
    setError(null);

    const { error: signInError } = await authClient.signIn.email({ email, password });

    if (!signInError) {
      await goWhereTheyBelong();
      setPending(false);
      return;
    }

    const { error: signUpError } = await authClient.signUp.email({
      email,
      password,
      name: email.split("@")[0] || email,
    });

    const message = emailAuthMessage(signInError, signUpError);
    if (message) {
      setError(message);
      setPending(false);
      return;
    }

    await goWhereTheyBelong();
    setPending(false);
  };

  /**
   * A provider hands off to a full-page redirect, so there is nothing to await and no success path
   * to handle here — the browser leaves, and Better Auth brings it back to `callbackURL` signed in
   * or to `errorCallbackURL` with the code this route reads on arrival (`socialSignInUrls`). A
   * provider the server did not register fails at this call rather than silently doing nothing,
   * which is why the error is surfaced instead of swallowed.
   */
  const continueWith = async (provider: SocialProviderName) => {
    setPending(true);
    setError(null);

    const { error: socialError } = await authClient.signIn.social({
      provider,
      ...socialSignInUrls(window.location.origin, returnTo),
    });

    if (socialError) {
      setError(socialError.message ?? "Could not sign in with the provider.");
      setPending(false);
    }
  };

  return (
    // Cando's pre-auth frame (its `routes/login.tsx`): the header band, the large heading, the
    // card beneath. Without the strip of faces along the bottom, and so without the `md:pb-40`
    // that cleared it and the `overflow-hidden` that clipped it (ADR 0017).
    <div className="flex min-h-svh flex-col">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6">
        <h1 className="text-center text-4xl tracking-tight">Sign in to Graft</h1>
        <SignInCard
          className="mt-9 md:mt-8"
          step={step}
          pending={pending}
          error={error}
          providers={methods.data?.social ?? []}
          onSubmitEmail={(value) => {
            setEmail(value);
            setError(null);
            setStep("password");
          }}
          onSubmitPassword={continueWithEmail}
          onProvider={continueWith}
        />
      </main>
    </div>
  );
}
