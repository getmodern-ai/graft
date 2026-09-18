import type { SocialProviderName } from "@graft/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AuthHeader } from "@/components/auth/auth-header";
import { SignInCard, type SignInStep } from "@/components/auth/sign-in-card";
import { VerifyEmailNotice } from "@/components/auth/verify-email-notice";
import {
  attemptEmailSignIn,
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
 * The sign-in door — Cando's `routes/login.tsx` (its CAN-64, CAN-295, CAN-476), GRA-81 and GRA-94.
 * This door only signs people in: registering is `/signup`'s job (ADR 0020 as amended), so an
 * address the product has never seen fails here exactly like a wrong password, and deliberately
 * so — Better Auth answers both with the identical 401, because distinguishing them is account
 * enumeration. The footer's cross-link is the honest exit for a visitor who has no account.
 *
 * `redirect` is where the `_auth` guard sent the visitor from — a handoff URL, typically (ADR 0006)
 * — and is honoured only as a same-origin path (`safe-redirect.ts`). `email` pre-fills the address:
 * the account-exists email's link and the verification link both carry it. `error` is how a
 * provider round trip or a dead verification link comes back here, Better Auth's code, read once
 * into a sentence and never shown raw.
 */
export const Route = createFileRoute("/login")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; error?: string; email?: string } => {
    const redirect = safeRedirectPath(search.redirect);
    const error = typeof search.error === "string" && search.error ? search.error : undefined;
    const email = typeof search.email === "string" && search.email ? search.email : undefined;
    return {
      ...(redirect ? { redirect } : {}),
      ...(error ? { error } : {}),
      ...(email ? { email } : {}),
    };
  },
  /**
   * A signed-in visitor is sent where they belong rather than parked on a form they do not need —
   * which is also how the verification link lands: Better Auth's GET opens the session and sends
   * the browser here, and this guard sends it on. A signed-out one has the provider list before the
   * card paints, so the buttons never pop in.
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
  const { redirect: returnTo, error: returnedError, email: prefill } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const methods = useQuery(signInMethodsQuery);
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState(prefill ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => socialSignInMessage(returnedError));
  /** The address the "check your email" card names — frozen at submit, like forgot-password's. */
  const [verificationSentTo, setVerificationSentTo] = useState<string | null>(null);

  const goWhereTheyBelong = async () => {
    // The guard decides from `sessionQuery`; drop the signed-out entry before it reads again.
    queryClient.removeQueries({ queryKey: sessionKeys.current });
    await navigate({ href: returnTo ?? DEFAULT_SIGNED_IN_PATH });
  };

  /**
   * The card's resend. The link returns to this door with its search intact, where the guard sends
   * a now-verified visitor on.
   */
  const resendVerification = async () => {
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: verificationSentTo ?? email,
        callbackURL: verificationReturnURL(window.location.origin, { returnTo, email }),
      });
      return { error: error ? "We couldn't send another link. Try again." : null };
    } catch {
      return { error: NETWORK_FAILURE_MESSAGE };
    }
  };

  const continueWithEmail = async (password: string) => {
    setPending(true);
    setError(null);

    try {
      // The callback rides along for the one case that uses it: an unverified account, whose
      // re-sent link should land back on this door with `redirect` and the address intact.
      const attempt = await attemptEmailSignIn(
        {
          email,
          password,
          callbackURL: verificationReturnURL(window.location.origin, { returnTo, email }),
        },
        (input) => authClient.signIn.email(input),
      );

      if (!attempt.signedIn) {
        // Right password, unverified address (GRA-94): the server has just re-sent the link.
        if (attempt.error === null) {
          setVerificationSentTo(email);
          return;
        }
        setError(attempt.error);
        return;
      }

      await goWhereTheyBelong();
    } catch {
      setError(NETWORK_FAILURE_MESSAGE);
    } finally {
      setPending(false);
    }
  };

  /**
   * A provider hands off to a full-page redirect, so there is nothing to await and no success path
   * to handle here — the browser leaves, and Better Auth brings it back to `callbackURL` signed in
   * or to `errorCallbackURL` with the code this route reads on arrival (`socialSignInUrls`).
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
    // Cando's pre-auth frame (its `routes/login.tsx`): the header band, the large heading, the
    // card beneath. Without the strip of faces along the bottom, and so without the `md:pb-40`
    // that cleared it and the `overflow-hidden` that clipped it (ADR 0017).
    <div className="flex min-h-svh flex-col">
      <AuthHeader />

      <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6">
        <h1 className="text-center text-4xl tracking-tight">Sign in to Graft</h1>
        {verificationSentTo ? (
          <VerifyEmailNotice
            className="mt-9 md:mt-8"
            email={verificationSentTo}
            description="Your address isn't verified yet, so we sent you a fresh link. Open it to sign in."
            onResend={resendVerification}
          />
        ) : (
          <SignInCard
            className="mt-9 md:mt-8"
            step={step}
            pending={pending}
            error={error}
            email={email}
            onEmailChange={setEmail}
            providers={methods.data?.social ?? []}
            onSubmitEmail={() => {
              setError(null);
              setStep("password");
            }}
            onSubmitPassword={continueWithEmail}
            onProvider={continueWith}
            footer={
              <p className="text-center text-muted-foreground text-sm">
                New to Graft?{" "}
                {/* `redirect` rides along, so switching doors never drops a handoff. */}
                <Link
                  to="/signup"
                  search={{ redirect: returnTo }}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Create an account
                </Link>
              </p>
            }
          />
        )}
      </main>
    </div>
  );
}
