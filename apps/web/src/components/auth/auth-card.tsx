import type * as React from "react";

import { PageContainer } from "@/components/page/page-container";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The card both doors put their form in: `max-w-md`, with the page column's `xs` inset inside the
 * card's own padding — Cando's `SignInCard` frame (`apps/web/src/components/auth/sign-in-card.tsx`)
 * without its two-beat email-then-password flow and its Google button, neither of which Graft
 * has. The routes own what differs: the fields, the submit's promise, and the footer's cross-link.
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
