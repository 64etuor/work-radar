import { Popover as PopoverPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // 상호작용 계약(overlay-stack): 열린 동안 `data-wr-overlay-open` 마커 → isOverlayOpen()/knob 참조.
  // 추가로 Esc는 이 popover만 닫고 **window로 버블되지 않게 전파를 끊는다** — App.tsx의 window-bubble
  // Esc 핸들러가 보드에서 `getCurrentWindow().hide()`를 깨우지 못하게(마커 타이밍 의존 제거: controlled
  // close의 unmount가 native Esc 버블보다 먼저 일어나도 안전). 닫기는 Radix 기본(preventDefault 안 함).
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-wr-overlay-open
        align={align}
        sideOffset={sideOffset}
        onEscapeKeyDown={(e) => {
          e.stopPropagation();
          onEscapeKeyDown?.(e);
        }}
        className={cn(
          "bg-popover text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 border-border z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <div data-slot="popover-title" className={cn("font-medium", className)} {...props} />;
}

function PopoverDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
