import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "./cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        secondary: "bg-secondary text-secondary-foreground hover:brightness-95",
        outline: "border border-input bg-background text-foreground hover:bg-muted",
        ghost: "text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
        destructiveOutline:
          "border border-destructive/40 text-destructive hover:bg-destructive-soft hover:border-destructive/60",
        destructiveGhost: "text-destructive hover:bg-destructive-soft",
      },
      size: {
        default: "h-9 px-4 py-2 rounded-md",
        sm: "h-8 px-3 text-xs rounded-md",
        pill: "h-9 px-5 rounded-full",
        // 앱 셸의 지배적 pill 실사용(h-8 + 12px 라벨)을 프리미티브로 승격 —
        // 소비처의 `rounded-full text-[12px]` 수기 조합을 대체한다.
        "pill-sm": "h-8 px-3.5 text-xs rounded-full",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
