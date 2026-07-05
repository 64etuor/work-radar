import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * 2-step 삭제 버튼 — 첫 클릭은 arm(라벨 "확인"으로 3초), 두 번째 클릭만 실행.
 * KR/Objective는 체크인 이력까지 cascade 하드삭제라 원클릭 사고 비용이 크다.
 */
export function ArmedDeleteButton({
  onConfirm,
  disabled,
  label,
  confirmLabel = "삭제 확인",
  variant = "destructiveGhost",
  ariaLabel,
}: {
  onConfirm: () => void;
  disabled?: boolean;
  /** 평시 라벨. 없으면 아이콘만. */
  label?: string;
  confirmLabel?: string;
  variant?: "destructiveGhost" | "destructiveOutline";
  ariaLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={disabled}
      aria-label={armed ? confirmLabel : ariaLabel}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          timerRef.current = window.setTimeout(() => setArmed(false), 3000);
          return;
        }
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
    >
      <Trash2 className="size-4" />
      {armed ? confirmLabel : label}
    </Button>
  );
}
