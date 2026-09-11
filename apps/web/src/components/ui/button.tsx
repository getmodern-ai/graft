import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border border-transparent bg-clip-padding font-medium text-sm outline-none transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Solid variants are flat fills that hover by lifting — the bevel and cast
        // shadow deepen (`shadow-button-hover`) — and only `default` also washes its
        // fill 8% lighter (`hover:button-sheen`). Disabled keeps the rest shadow and
        // fades whole. Read off the DS Button states, CAN-291; re-measured against the
        // round-2 sheet (DS 6716:46634) on CAN-317, which draws the same result with a
        // different mechanism — a black/20% base fill under a 1px-inset surface frame
        // instead of an inset shadow — so nothing here moved.
        default:
          "hover:button-sheen bg-primary text-primary-foreground shadow-button hover:shadow-button-hover",
        // `bg-custom-bg-input-30-trans-light` is the token the DS binds as
        // `component/button/variant-outline/bg` — white in light, 4% foreground in
        // dark — and hover is plain `muted` in both modes, so the shadcn
        // `dark:bg-input/30`/`dark:hover:bg-input/50` overrides came off (CAN-317).
        outline:
          "border-input bg-custom-bg-input-30-trans-light hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-button hover:shadow-button-hover aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        // Ghost hovers to plain `muted` in both modes on the round-2 sheet, so the
        // shadcn `dark:hover:bg-muted/50` half-tint came off (CAN-317).
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-button hover:shadow-button-hover focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        // `sm` keeps the base 16px icons — the frame's only size-specific icon
        // override is xs. Its label is drawn at 13px (`text/button-sm/size`), a step
        // the type scale does not have; `text-xs` is the nearest token and the
        // recorded deviation, CAN-291.
        sm: "h-7 gap-1 rounded-md px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
