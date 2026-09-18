import type { SocialProviderName } from "@graft/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthHeader } from "@/components/auth/auth-header";
import { SignInCard, type SignInStep } from "@/components/auth/sign-in-card";
import { VerifyEmailNotice } from "@/components/auth/verify-email-notice";
import {
  attemptEmailSignUp,
  attemptSocialSignIn,
  NETWORK_FAILURE_MESSAGE,
} from "@/lib/auth-attempt";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_SIGNED_IN_PATH, safeRedirectPath } from "@/lib/safe-redirect";
import { sessionKeys, sessionQuery } from "@/lib/session-queries";
import {
  signInMethodsQuery,
  socialSignInMessage,
  socialSignInUrls,
  verificationReturnURL,
} from "@/lib/sign-in";

/**
 * The sign-up door — Cando's `routes/signup.tsx` (its CAN-295, CAN-476), GRA-94; the other half
 * of ADR 0020 as amended. Drawn from the same card as `/login` with the sign-up's labels: "Create
 * account" once a password is being invented, no "Forgot password?", and a password manager asked
 * to generate rather than fill.
 *
 * Registering opens no session until the address is verified: the ordinary answer is a 200 with
 * no token and a verification email on its way, and the door shows "check your email". A taken
 * address gets the very same answer — Better Auth shapes the two identically, so the wire confirms
 * nothing — and the inbox is where the difference lands, as "you already have an account". The
 * emailed link returns the visitor to `/login` with `redirect` and `email` carried, where the
 * guard sends a now-signed-in visitor on.
 */
export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; error?: string } => {
    const redirect = safeRedirectPath(search.redirect);
    const error = typeof search.error === "string" && search.error ? search.error : undefined;
    return { ...(redirect ? { redirect } : {}), ...(error ? { error } : {}) };
  },
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData({
      ...sessionQuery,
      revalidateIfStale: true,
    });
    if (session) throw redirect({ href: search.redirect ?? DEFAULT_SIGNED_IN_PATH });
    await context.queryClient.ensureQueryData(signInMethodsQuery);
  },
  component: SignupRoute,
});

function SignupRoute() {
  const { redirect: returnTo, error: returnedError } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const methods = useQuery(signInMethodsQuery);
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => socialSignInMessage(returnedError));
  const [verificationSentTo, setVerificationSentTo] = useState<string | null>(null);

  const returnURL = () => verificationReturnURL(window.location.origin, { returnTo, email });

  const resendVerification = async () => {
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: verificationSentTo ?? email,
        callbackURL: returnURL(),
      });
      return { error: error ? "We couldn't send another link. Try again." : null };
    } catch {
      return { error: NETWORK_FAILURE_MESSAGE };
    }
  };

  const createAccount = async (password: string) => {
    setPending(true);
    setError(null);

    try {
      const attempt = await attemptEmailSignUp(
        { email, password, callbackURL: returnURL() },
        (input) => authClient.signUp.email(input),
      );

      if (!attempt.signedIn) {
        if (attempt.error === null) {
          setVerificationSentTo(email);
          return;
        }
        setError(attempt.error);
        return;
      }

      // A configuration that verifies nothing opened a session on the spot.
      queryClient.removeQueries({ queryKey: sessionKeys.current });
      await navigate({ href: returnTo ?? DEFAULT_SIGNED_IN_PATH });
    } catch {
      setError(NETWORK_FAILURE_MESSAGE);
    } finally {
      setPending(false);
    }
  };

  /**
   * The same handoff as `/login`'s, deliberately: a provider continue is neither sign-in nor
   * sign-up until the provider answers, and ADR 0020's linking is what makes it reach an existing
   * password account instead of minting a duplicate.
   */
  const continueWith = async (provider: SocialProviderName) => {
    setPending(true);
    setError(null);
    const { error } = await attemptSocialSignIn(provider, () =>
      authClient.signIn.social({ provider, ...socialSignInUrls(window.location.origin, returnTo) }),
    );
    if (error) {
      setError(error);
      setPending(false);
    }
  };

  return (
    // The same pre-auth frame as `/login` — this screen is that screen's sibling, and should read
    // as one.
    <div className="flex min-h-svh flex-col">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6">
        <h1 className="text-center text-4xl tracking-tight">Welcome to Graft</h1>
        {verificationSentTo ? (
          <VerifyEmailNotice
            className="mt-9 md:mt-8"
            email={verificationSentTo}
            description="Open the link in it to finish creating your account."
            onResend={resendVerification}
          />
        ) : (
          <SignInCard
            className="mt-9 md:mt-8"
            step={step}
            pending={pending}
            error={error}
            // "Create account" only once a password is being invented — the email step's promise
            // is the same "Continue with email" as the sign-in door's.
            submitLabel={step === "password" ? "Create account" : undefined}
            email={email}
            onEmailChange={setEmail}
            // Inventing a password, not recalling one: no "Forgot password?", and password
            // managers are asked to generate rather than fill.
            showForgotPassword={false}
            passwordAutoComplete="new-password"
            providers={methods.data?.social ?? []}
            onSubmitEmail={() => {
              setError(null);
              setStep("password");
            }}
            onSubmitPassword={createAccount}
            onProvider={continueWith}
            footer={
              <p className="text-center text-muted-foreground text-sm">
                Already have an account?{" "}
                <Link
                  to="/login"
                  search={{ redirect: returnTo }}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Sign in
                </Link>
              </p>
            }
          />
        )}
      </main>
    </div>
  );
}
