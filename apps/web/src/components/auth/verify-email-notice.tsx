import { useState } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";

type VerifyEmailNoticeProps = {
  /** The address the email went to — frozen by the route at submit, so edits cannot confuse it. */
  email: string;
  /** What just happened, in the door's own words — sign-up and sign-in phrase it differently. */
  description: string;
  /**
   * Asks the server for another link. Resolves to a message for the card — `null` for a plain
   * "sent" — rather than throwing, so the route owns how the auth client's answer is read.
   */
  onResend: () => Promise<{ error: string | null }>;
  className?: string;
};

/**
 * The "check your email" card both doors show once registering or signing in has left a
 * verification link in the visitor's inbox — Cando's `verify-email-notice.tsx` (its CAN-476),
 * GRA-94. Drawn in the forgot-password confirmation's frame — heading, two sentences, one action —
 * because that is the one such state the design already has, and this is the same moment: the
 * product has done its part and the inbox is next.
 *
 * The address is named so a typo is caught here, before the visitor waits on mail that can never
 * arrive; the resend exists for the spam-folder case. What the card never does is say whether an
 * account already existed for the address — sign-up's copy holds for both cases on purpose, and
 * the inbox is where the difference is allowed to land (ADR 0020).
 */
function VerifyEmailNotice({ email, description, onResend, className }: VerifyEmailNoticeProps) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const resend = async () => {
    setPending(true);
    setOutcome(null);
    try {
      const { error } = await onResend();
      setOutcome(error ?? `We sent another link to ${email}.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthCard className={className}>
      <div className="flex flex-col items-center gap-6">
        <div className="flex flex-col gap-1.5 text-center">
          <h2 className="font-medium text-lg">Check your email</h2>
          <p className="text-balance text-base">{description}</p>
          <p className="text-balance text-base">
            We sent it to <span className="font-medium">{email}</span>. If it does not arrive within
            a few minutes, check your spam folder.
          </p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Button type="button" variant="outline" onClick={resend} disabled={pending}>
            Resend email
          </Button>
          {outcome && (
            <p className="text-center text-muted-foreground text-sm" role="status">
              {outcome}
            </p>
          )}
        </div>
      </div>
    </AuthCard>
  );
}

export { VerifyEmailNotice };
