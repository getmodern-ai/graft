import type { SocialProviderName } from "@graft/auth";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";

import githubMark from "@/assets/github-mark.svg";
import googleMark from "@/assets/google-mark.svg";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SOCIAL_PROVIDER_LABELS } from "@/lib/sign-in";
import { cn } from "@/lib/utils";

/**
 * Cando's sign-in card (its `apps/web/src/components/auth/sign-in-card.tsx`, CAN-64, CAN-295; GRA-81,
 * GRA-94), less one thing Graft does not have: the invitation's locked address, which needs an
 * organisation (ADR 0007). One card, two doors: `/login` and `/signup` draw it with different
 * labels, autocomplete and footer, so they read as one screen. The provider buttons are drawn from the list the server answers
 * rather than fixed to Apple and Google — Graft's are Google and GitHub, and a self-host may have
 * neither (`lib/sign-in.ts`).
 *
 * The password step is the same card, not a second screen: the email field stays put and the
 * password field appears beneath it. Anything that navigated would throw away the typed email
 * and the card's position on the page, which is the whole point of asking in two beats. The
 * address itself is the route's state, because the route needs it after the card is gone — the
 * "check your email" notice names it, and the verification link returns to it.
 */
type SignInStep = "email" | "password";

type SignInCardProps = {
  step: SignInStep;
  /** The address, owned by the route: the sign-up door's verification return URL and the notice both name it. */
  email: string;
  onEmailChange: (email: string) => void;
  onSubmitEmail: () => void;
  onSubmitPassword: (password: string) => void;
  /** The providers the server holds clients for, in the order to draw them; empty draws no rule. */
  providers: readonly SocialProviderName[];
  onProvider: (provider: SocialProviderName) => void;
  pending?: boolean;
  error?: string | null;
  /** The submit's label; the sign-up door says "Create account" once a password is being invented. */
  submitLabel?: string;
  /** Off on the sign-up door: inventing a password, not recalling one. */
  showForgotPassword?: boolean;
  /** `new-password` on the sign-up door, so a manager offers to generate rather than fill. */
  passwordAutoComplete?: "current-password" | "new-password";
  /** The cross-link to the other door, under the buttons. */
  footer?: ReactNode;
  className?: string;
};

function SignInCard({
  step,
  email,
  onEmailChange,
  onSubmitEmail,
  onSubmitPassword,
  providers,
  onProvider,
  pending = false,
  error = null,
  submitLabel = "Continue with email",
  showForgotPassword = true,
  passwordAutoComplete = "current-password",
  footer = null,
  className,
}: SignInCardProps) {
  const [password, setPassword] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }

    if (step === "email") {
      onSubmitEmail();
      return;
    }

    onSubmitPassword(password);
  };

  return (
    <AuthCard className={className}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="sign-in-email" className="leading-none">
              Email
            </FieldLabel>
            <Input
              id="sign-in-email"
              name="email"
              type="email"
              placeholder="m@example.com"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              disabled={pending}
            />
          </Field>

          {step === "password" && (
            <Field>
              {/* The link shares the label's row, and exists only once the password field
                  does — "Forgot password?" is an answer to a question this card has not
                  asked before this step. It carries the typed address so the request form
                  starts filled. */}
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="sign-in-password" className="leading-none">
                  Password
                </FieldLabel>
                {showForgotPassword && (
                  <Link
                    to="/forgot-password"
                    search={{ email: email || undefined }}
                    className="text-muted-foreground text-sm underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <Input
                id="sign-in-password"
                name="password"
                type="password"
                autoComplete={passwordAutoComplete}
                required
                minLength={8}
                // The field appears mid-interaction, so the caret has to follow it.
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={pending}
              />
            </Field>
          )}

          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>

        <Button type="submit" className="w-full" disabled={pending}>
          {submitLabel}
        </Button>

        {providers.length > 0 && (
          <>
            {/* Two rules with the word between them, as drawn — not FieldSeparator, whose
                overlaid label paints itself `bg-background` and would show as a lighter
                notch against the card in dark mode. */}
            <div className="flex items-center gap-2.5">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-sm">Or</span>
              <Separator className="flex-1" />
            </div>

            <div className="flex flex-col gap-2">
              {providers.map((provider) => (
                <Button
                  key={provider}
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => onProvider(provider)}
                  disabled={pending}
                >
                  <BrandMark provider={provider} />
                  Continue with {SOCIAL_PROVIDER_LABELS[provider]}
                </Button>
              ))}
            </div>
          </>
        )}

        {footer}
      </form>
    </AuthCard>
  );
}

/**
 * A provider logo in the 24px box the design gives it, Cando's `BrandMark`: the glyphs are flat
 * exported artwork at their drawn size, centred rather than stretched to fill, so the optical
 * weight of the marks stays as the designer set it — and, being files rather than components, they
 * sit outside the colour guard (ADR 0017), which reads `.ts` and `.tsx` alone.
 *
 * `monochrome` inverts in dark mode. A flat image cannot take `currentColor`, and GitHub's mark
 * is drawn in the foreground colour, as Cando's Apple mark is — left alone it disappears into a
 * dark button. Google's four-colour G is exempt: their brand terms forbid recolouring it.
 */
const MARKS: Record<SocialProviderName, { src: string; monochrome: boolean }> = {
  google: { src: googleMark, monochrome: false },
  github: { src: githubMark, monochrome: true },
};

function BrandMark({ provider }: { provider: SocialProviderName }) {
  const mark = MARKS[provider];
  return (
    <span className="flex size-6 shrink-0 items-center justify-center">
      <img src={mark.src} alt="" className={cn(mark.monochrome && "dark:invert")} />
    </span>
  );
}

export { SignInCard, type SignInStep };
