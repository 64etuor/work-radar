import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import * as React from "react";

import { cn } from "./cn";

type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  /**
   * Indicator(체크 마크) 슬롯. 생략 시 기본 lucide `<Check size-3>` 사용.
   * 항상 보이게(opacity 토글 CSS 패턴) 그리려면 `forceMountIndicator`를 켠다 —
   * Today/Routines의 `.cb-check svg{opacity:0}` 디자인 토큰 호환용.
   */
  indicator?: React.ReactNode;
  forceMountIndicator?: boolean;
};

export function Checkbox({ className, indicator, forceMountIndicator, ...props }: CheckboxProps) {
  // wr-check-pop은 "마운트 이후의 사용자 체크"에만 단다. 게이트가 없으면 첫 렌더부터
  // checked인 리스트(뷰 전환 key 리마운트 포함)와 forceMount 소비처(마운트≠체크,
  // 예: TimelineBlock의 기본 인디케이터)가 일제히 팝을 재생한다(팝 폭풍).
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    mountedRef.current = true;
  }, []);
  return (
    <CheckboxPrimitive.Root className={className} {...props}>
      <CheckboxPrimitive.Indicator forceMount={forceMountIndicator ? true : undefined}>
        {indicator ?? (
          <span
            className={cn(
              // 의도된 ref-in-render 마운트 게이트: ref 변이는 리렌더를 안 일으켜 "첫 페인트엔
              // 팝 없음, 이후 체크 리렌더부터 부착"이 성립한다. (state로 바꾸면 마운트 직후
              // 재렌더에서 클래스가 추가되며 애니메이션이 발화 — 팝 폭풍 재발.)
              // eslint-disable-next-line react-hooks/refs
              !forceMountIndicator && mountedRef.current && "wr-check-pop",
              "flex items-center justify-center text-current",
            )}
          >
            <Check className="size-3" />
          </span>
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
