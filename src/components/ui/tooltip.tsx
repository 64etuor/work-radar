import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "./cn";

function TooltipProvider({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  // 상호작용 계약(overlay-stack): 열린 동안 `data-wr-overlay-open` 마커 → Esc가 tooltip만
  // 닫고 App.tsx의 window.hide()는 양보된다. Content는 닫히면 unmount되어 마커가 사라진다.
  // radix Popover/Select Content와 동일 컨벤션.
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-wr-overlay-open
        sideOffset={sideOffset}
        className={cn(
          // enter 모션만 wr-tooltip-content(motion.css)로 — exit 애니메이션은 unmount를 지연시켜
          // data-wr-overlay-open 마커가 호버 툴팁 소멸 후에도 살아남아 전역 키를 죽인다(금지).
          "bg-popover text-popover-foreground border-border wr-tooltip-content z-50 origin-(--radix-tooltip-content-transform-origin) rounded-md border px-3 py-2 text-xs shadow-md outline-hidden",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
