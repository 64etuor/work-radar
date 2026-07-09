import type { ReactNode } from "react";

import { cn } from "./cn";

/**
 * EmptyState — "표시할 게 없음" 블록의 단일 프리미티브(DESIGN.md §App Surface Type).
 * 앱 곳곳에 `.{prefix}-empty` 로 12번 재발명돼 있던 타이포/색 레시피를 여기로 모은다.
 *
 * 규약:
 * - 타이포/색만 소유한다. 바깥 padding·border·배경 등 geometry 는 소비자가 `className` 으로 넘긴다.
 * - 본문은 `typo-body-md text-muted-foreground`, 선택적 title 은 `typo-body-strong text-foreground`.
 * - 텍스트는 자식 요소에 직접 적용되므로, 컨테이너 CSS 의 상속 font/color 를 항상 이긴다.
 */
export function EmptyState({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1.5 text-center", className)}>
      {title != null && <div className="typo-body-strong text-foreground">{title}</div>}
      {children != null && <div className="typo-body-md text-muted-foreground">{children}</div>}
    </div>
  );
}
