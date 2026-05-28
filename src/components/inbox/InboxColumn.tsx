import "./InboxColumn.css";

import type { ReactNode, Ref } from "react";

type Props = {
  /** mono uppercase 태그(예: "Inbox"). */
  label: string;
  /** 부제(한글). 없으면 생략. */
  ko?: string;
  /** 우측 count chip. undefined면 생략. */
  count?: number;
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
};

/**
 * 점선 회색 well + 좌상단 col-label(mono "Label" + sans "부제" + count chip).
 * capture board의 `.inbox` 컬럼 비주얼을 표시 전용 공유 컴포넌트로 추출.
 * 너비 178px 고정(capture board와 동일). 본문 레이아웃은 children 소비자 책임.
 */
export function InboxColumn({ label, ko, count, className, children, ref }: Props) {
  const cn = `inbox-column${className ? ` ${className}` : ""}`;
  return (
    <div ref={ref} className={cn}>
      <div className="inbox-column-label">
        <span className="inbox-column-tag">{label}</span>
        {ko && <span className="inbox-column-ko">{ko}</span>}
        {count !== undefined && <span className="inbox-column-count">{count}</span>}
      </div>
      {children}
    </div>
  );
}
