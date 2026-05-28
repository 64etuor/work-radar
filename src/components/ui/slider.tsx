import * as SliderPrimitive from "@radix-ui/react-slider";
import type * as React from "react";

import { cn } from "./cn";

// React 19+: ref는 일반 prop으로 받는다 (forwardRef 불필요).
function Slider({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="bg-wr-surface relative h-1.5 w-full grow overflow-hidden rounded-full">
        <SliderPrimitive.Range className="bg-wr-near-black absolute h-full" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="border-wr-border bg-wr-bg focus-visible:ring-wr-focus block size-4 rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none" />
    </SliderPrimitive.Root>
  );
}

export { Slider };
