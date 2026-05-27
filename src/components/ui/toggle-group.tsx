import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

// 세그먼트 컨트롤(2+ 상태). overlay 아님 → Esc/포커스 계약 불필요(raw shadcn 래퍼).
// 활성 시각은 소비처가 data-[state=on]:* 으로 지정(seg마다 의미색이 달라 base에 굳히지 않음).
const toggleGroupItemVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-9 px-3 text-sm",
        sm: "h-8 px-2.5 text-xs",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root className={cn("inline-flex items-center", className)} {...props} />
  );
}

export function ToggleGroupItem({
  className,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleGroupItemVariants>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(toggleGroupItemVariants({ size }), className)}
      {...props}
    />
  );
}
