import type * as React from "react";

import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";

/**
 * A step's heading: the page's `h1` and the one sentence under it, in `PageHeader`'s type, since
 * a Setup step is the page. Every step component opens with one.
 */
export function SetupStepHeader({
  title,
  description,
}: {
  title: string;
  description: React.ReactNode;
}) {
  return (
    <PageHeader>
      <PageHeaderContent>
        <PageHeaderTitle>{title}</PageHeaderTitle>
        <PageHeaderDescription>{description}</PageHeaderDescription>
      </PageHeaderContent>
    </PageHeader>
  );
}
