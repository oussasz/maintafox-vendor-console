import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-dark",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        /** A sensitive action shown next to ordinary ones: white, red text and border. */
        "destructive-outline": "border border-danger-border bg-white text-danger hover:bg-danger-bg",
        outline: "border border-input bg-white text-text-primary hover:bg-surface-3",
        secondary: "border border-input bg-white text-text-primary hover:bg-surface-3",
        ghost: "text-text-primary hover:bg-surface-3",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-[18px]",
        sm: "h-10 px-3.5 text-[13px]",
        lg: "h-12 px-8",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
