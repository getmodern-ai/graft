"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

// `gap-2` is the frame's 8px between triggers, and it belongs on every variant: in Figma the
// spacing sits on the list's inner slot, which all three list styles share, so reading it off
// `TabsList` itself made it look absent. Measured on `281:99296`, `281:99309` and `281:105386` —
// triggers at x=0/64/128/223/295 with widths 56/56/87/64/66, i.e. 8px between each. See CAN-125.
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center gap-2 rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "rounded-md bg-transparent",
        // The spec's third list style: transparent like `line`, but the active
        // trigger reads as a pressed button rather than a lifted card.
        button: "rounded-md bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        // Triggers hug their label — the spec sizes them HUG with layoutGrow 0, so
        // flex-1 stretched them to equal widths. `min-w-14` is the frame's 56px floor on that
        // hug, which is what a short label like "All" sits at: 6px padding would give it 28,
        // and the frame centres its 16px label inside 56. Long labels never reach the floor and
        // keep hugging, which is why `px-1.5` is already right and must stay 6px. CAN-125.
        "relative inline-flex h-6 min-w-14 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent px-1.5 py-0.5 font-medium text-muted-foreground text-sm transition-all hover:text-primary focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:py-[calc(--spacing(1.25))] dark:text-muted-foreground dark:hover:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        // shadows/tabs-active — the active tab lifts off the muted list. The
        // `button` list styles its active trigger as muted with no lift, and only
        // `default` and `button` turn primary on hover; `line` goes to foreground.
        "data-active:bg-background data-active:text-foreground data-active:shadow-sm dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "group-data-[variant=line]/tabs-list:data-active:shadow-none group-data-[variant=line]/tabs-list:hover:text-foreground",
        "group-data-[variant=button]/tabs-list:data-active:bg-muted group-data-[variant=button]/tabs-list:data-active:shadow-none",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-xs/relaxed outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
