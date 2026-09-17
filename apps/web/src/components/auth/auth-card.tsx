import type * as React from "react";

import { PageContainer } from "@/components/page/page-container";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The card a pre-auth screen puts its form in: `max-w-md`, with the page column's `xs` inset inside
 * the card's own padding — the frame of Cando's `SignInCard`
 * (`apps/web/src/components/auth/sign-in-card.tsx`), which `sign-in-card.tsx` here fills with that
 * card's two-beat flow (GRA-81). Kept apart from it so a screen that is not the door — a consent
 * with no session, say — can wear the same frame.
 */
export function AuthCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("w-full max-w-md", className)}>
      <CardContent>
        <PageContainer size="xs">{children}</PageContainer>
      </CardContent>
    </Card>
  );
}
