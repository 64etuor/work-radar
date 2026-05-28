import "./PostitCard.css";

import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";

/** 좌 테두리 색을 결정하는 사분면 슬러그(없으면 sticky 기본색). */
export type PostitQuadrant = "q1" | "q2" | "q3" | "q4";

type Props = Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  /** 좌 테두리 색 (사분면). 미분류면 생략. */
  quadrant?: PostitQuadrant | null;
  /** 카드 상단 슬롯 — chip/아이콘/완료체크 등. */
  tags?: ReactNode;
  /** 좌하단 메타(date/freq 등). */
  footer?: ReactNode;
  /** 드래그 중 표시(opacity·cursor). dnd-kit `isDragging` 그대로 패스. */
  dragging?: boolean;
  /** 본문(제목). */
  body: ReactNode;
  ref?: Ref<HTMLDivElement>;
};

/**
 * Postit 풀카피 카드 — capture board postit과 동일 비주얼(좌 테두리 사분면 색 +
 * 150px 고정 폭 + tag 슬롯 + body + date footer). 표시 전용 — 편집/팝오버 없음.
 * board의 `.cb .postit`은 absolute 배치라 별도 클래스(`.postit-card`)로 분리.
 */
export function PostitCard({
  quadrant,
  tags,
  footer,
  dragging,
  body,
  className,
  ref,
  ...rest
}: Props) {
  const qClass = quadrant ? ` postit-card--${quadrant}` : "";
  const extra = className ? ` ${className}` : "";
  return (
    <div
      ref={ref}
      className={`postit-card${qClass}${extra}`}
      data-dragging={dragging || undefined}
      {...rest}
    >
      {tags && <div className="postit-card-tags">{tags}</div>}
      <div className="postit-card-body">{body}</div>
      {footer && <div className="postit-card-pdate">{footer}</div>}
    </div>
  );
}
