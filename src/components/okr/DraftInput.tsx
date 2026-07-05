import { useRef, useState } from "react";

import { Input } from "@/components/ui/input";

/**
 * blur/Enter 커밋 인라인 입력 — 포커스 동안만 로컬 draft, 평소엔 서버값 표시.
 * 리마운트 key 없이 refetch 덮임을 막는다(편집 중=focused 필드만 로컬).
 * Enter=커밋(blur), Esc=취소(draft 폐기, 셸 Esc로 새지 않게 소비).
 */
export function DraftInput({
  value,
  onCommit,
  ...props
}: {
  value: string;
  onCommit: (next: string) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onCommit">) {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc 취소 시 setState(null)가 blur 이벤트보다 늦게 반영돼 stale draft가 커밋되는 것을 막는 가드.
  const cancelingRef = useRef(false);

  return (
    <Input
      {...props}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setDraft(value)}
      onBlur={() => {
        if (!cancelingRef.current && draft !== null && draft !== value) onCommit(draft);
        cancelingRef.current = false;
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelingRef.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
