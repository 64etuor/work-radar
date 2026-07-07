import { type ComponentProps } from "react";

import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";

export function TableCellInput({
  align,
  cellWidth,
  className,
  ...props
}: ComponentProps<"input"> & {
  align?: "right";
  cellWidth?: "amount";
}) {
  return (
    <Input
      className={cn("bk-cell-input", className)}
      data-align={align}
      data-width={cellWidth}
      {...props}
    />
  );
}
