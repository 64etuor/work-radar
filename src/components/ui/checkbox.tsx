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
  return (
    <CheckboxPrimitive.Root className={className} {...props}>
      <CheckboxPrimitive.Indicator forceMount={forceMountIndicator ? true : undefined}>
        {indicator ?? (
          <span className={cn("flex items-center justify-center text-current")}>
            <Check className="size-3" />
          </span>
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
