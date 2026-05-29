import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "./cn";

// 우측 슬라이드오버. radix Dialog 위에 얹어 dialog.tsx와 동일한 overlay-stack 계약을 공유한다
// (열린 동안 `data-wr-overlay-open` 마커 → App 셸이 Esc로 창을 숨기지 않음, 닫히면 unmount되어 마커 소멸).
// detail 패널처럼 프로그램적(controlled open)으로 쓰는 게 일반적 — 트리거 없이도 마커가 창보호를 보장한다.

export const Sheet = DialogPrimitive.Root;
const SheetPortal = DialogPrimitive.Portal;

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn("wr-dialog-overlay fixed inset-0 z-50 bg-black/40", className)}
      {...props}
    />
  );
}

export function SheetContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-wr-overlay-open
        aria-describedby={undefined}
        // radix는 document에 capture-phase Esc 리스너를 달아 close 시 Content를 즉시 unmount한다 →
        // window로 버블될 시점엔 `data-wr-overlay-open` 마커가 이미 사라져, App 셸의 Esc 핸들러가
        // isOverlayOpen()=false로 보고 창을 숨기거나(보드) 뷰를 보드로 되돌릴 수 있다. radix가 시트를
        // 닫는 건 그대로 두되(이미 처리됨), Esc가 window까지 가지 못하게 막아 계약을 타이밍-독립적으로 만든다.
        onEscapeKeyDown={(e) => e.stopPropagation()}
        className={cn(
          "border-border bg-background fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-2xl flex-col gap-4 border-l p-6 shadow-lg",
          "wr-sheet-content",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close className="focus-visible:ring-ring absolute top-4 right-4 rounded-sm opacity-60 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2">
            <X className="size-4" />
            <span className="sr-only">닫기</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-foreground text-base font-semibold", className)}
      {...props}
    />
  );
}
