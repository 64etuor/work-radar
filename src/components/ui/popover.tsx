import { Popover as PopoverPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "./cn";

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
          // enter/exit 모션은 wr-popover-content(motion.css) — tw-animate 플러그인 미도입이라
          // shadcn 기본 animate-in/out 클래스는 no-op이어서 wr 배선으로 대체했다.
          "bg-popover text-popover-foreground border-border wr-popover-content z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
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
      className={cn("typo-body-md flex flex-col gap-1", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <div data-slot="popover-title" className={cn("typo-body-strong", className)} {...props} />;
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
