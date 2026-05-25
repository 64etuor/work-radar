import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";

import { cn } from "./cn";

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-wr-surface">
      <SliderPrimitive.Range className="absolute h-full bg-wr-near-black" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block size-4 rounded-full border border-wr-border bg-wr-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wr-focus focus-visible:ring-offset-2 disabled:pointer-events-none" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
