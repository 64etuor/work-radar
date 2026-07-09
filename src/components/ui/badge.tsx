import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "./cn";

const badgeVariants = cva("inline-flex items-center rounded-full border", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      outline: "border-border text-foreground",
      accent: "border-transparent bg-accent text-accent-foreground",
      destructive: "border-transparent bg-destructive text-destructive-foreground",
    },
    size: {
      default: "px-2.5 py-0.5 text-xs font-medium",
      // 메타데이터 칩 — typo-caption-sm(11px/400). 소비처 arbitrary text-[11px] 대체용.
      sm: "px-2 py-0.5 typo-caption-sm",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
